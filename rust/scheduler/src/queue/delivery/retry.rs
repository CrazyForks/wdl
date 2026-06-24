use std::collections::{HashMap, HashSet};

use redis::{Pipeline, Value};
use serde_json::json;

use crate::{AppState, CONSUMER_GROUP, LogLevel, Metrics, SERVICE, SchedulerResult, log, now_ms};

use super::super::{
    Consumer, DlqLog, InvalidAttemptLog, QUEUE_DELAYED_INDEX_KEY, QueueMessage, RetryAction,
    RetryBatchPlan, queue_delayed_key, queue_dlq_key,
};

const MAX_QUEUE_DELAY_SECONDS: i64 = 86_400;
const MILLIS_PER_SECOND: i64 = 1_000;

pub(crate) fn decide_retry_action(
    msg: &QueueMessage,
    delay_secs: i64,
    max_retries: i64,
    dead_letter_queue: Option<&str>,
    queue: &str,
    now: i64,
) -> RetryAction {
    let attempts = parse_next_attempts(&msg.attempts);
    let mut base = HashMap::from([
        ("id".to_string(), msg.id.clone()),
        ("body_b64".to_string(), msg.body_b64.clone()),
        ("content_type".to_string(), msg.content_type.clone()),
        ("attempts".to_string(), attempts.to_string()),
        ("first_seen_ms".to_string(), msg.first_seen_ms.clone()),
    ]);

    if attempts > max_retries {
        base.insert("reason".to_string(), "max_retries_exceeded".to_string());
        return RetryAction::Dlq {
            attempts,
            target: dead_letter_queue.unwrap_or(queue).to_string(),
            entry: base,
        };
    }
    if delay_secs > 0 {
        return RetryAction::Delay {
            visible_at_ms: retry_visible_at_ms(now, delay_secs),
            entry: base,
        };
    }
    RetryAction::Immediate { entry: base }
}

fn retry_visible_at_ms(now: i64, delay_secs: i64) -> i64 {
    now.saturating_add(
        delay_secs
            .clamp(0, MAX_QUEUE_DELAY_SECONDS)
            .saturating_mul(MILLIS_PER_SECOND),
    )
}

fn parse_next_attempts(raw: &str) -> i64 {
    match raw.parse::<i64>() {
        Ok(attempts) if attempts >= 0 => attempts.checked_add(1).unwrap_or(1),
        _ => 1,
    }
}

fn valid_attempts(raw: &str) -> bool {
    matches!(raw.parse::<i64>(), Ok(attempts) if attempts >= 0 && attempts.checked_add(1).is_some())
}

pub(crate) fn pipe_xadd_entry(
    pipe: &mut Pipeline,
    key: &str,
    trim: Option<usize>,
    entry: &HashMap<String, String>,
) {
    pipe.cmd("XADD").arg(key);
    if let Some(max_len) = trim {
        pipe.arg("MAXLEN").arg("~").arg(max_len);
    }
    pipe.arg("*");
    for (field, value) in entry {
        pipe.arg(field).arg(value);
    }
}

pub(crate) fn pipe_xack_xdel(pipe: &mut Pipeline, stream_key: &str, id: &str) {
    pipe.cmd("XACK").arg(stream_key).arg(CONSUMER_GROUP).arg(id);
    pipe.cmd("XDEL").arg(stream_key).arg(id);
}

pub(crate) async fn retry_messages_batch(
    state: &AppState,
    retries: Vec<(QueueMessage, i64)>,
    stream_key: &str,
    consumer: &Consumer,
) -> SchedulerResult<()> {
    if retries.is_empty() {
        return Ok(());
    }
    let plan = build_retry_batch_plan(
        retries,
        stream_key,
        consumer,
        state.config.max_dlq_len,
        now_ms(),
    )?;
    let RetryBatchPlan {
        pipe,
        retry_count,
        dlq_count,
        delayed_keys,
        dlq_logs,
        invalid_attempt_logs,
    } = plan;

    state
        .data_redis
        .with_conn(async |mut conn| pipe.query_async::<Value>(&mut conn).await)
        .await?;

    if !delayed_keys.is_empty() {
        state
            .queues
            .known_delayed
            .write()
            .await
            .extend(delayed_keys);
        state.queues.delayed_changed.notify_one();
    }
    for log_entry in dlq_logs {
        log(
            state,
            LogLevel::Warn,
            "queue_message_to_dlq",
            json!({
                "queue": consumer.queue,
                "dlq": log_entry.target,
                "msg_id": log_entry.msg_id,
                "attempts": log_entry.attempts,
                "max_retries": consumer.max_retries,
            }),
        );
    }
    for log_entry in invalid_attempt_logs {
        log(
            state,
            LogLevel::Warn,
            "queue_message_invalid_attempts",
            json!({
                "queue": consumer.queue,
                "msg_id": log_entry.msg_id,
                "stream_id": log_entry.stream_id,
                "attempts": log_entry.attempts,
            }),
        );
    }
    record_queue_messages(&state.metrics, "retry", retry_count);
    record_queue_messages(&state.metrics, "dlq", dlq_count);
    Ok(())
}

pub(crate) async fn terminal_messages_batch(
    state: &AppState,
    messages: Vec<QueueMessage>,
    stream_key: &str,
    consumer: &Consumer,
    reason: &str,
) -> SchedulerResult<()> {
    if messages.is_empty() {
        return Ok(());
    }
    let plan = build_terminal_batch_plan(
        messages,
        stream_key,
        consumer,
        state.config.max_dlq_len,
        reason,
    )?;
    let RetryBatchPlan {
        pipe,
        retry_count: _,
        dlq_count,
        delayed_keys: _,
        dlq_logs,
        invalid_attempt_logs,
    } = plan;

    state
        .data_redis
        .with_conn(async |mut conn| pipe.query_async::<Value>(&mut conn).await)
        .await?;

    for log_entry in dlq_logs {
        log(
            state,
            LogLevel::Warn,
            "queue_message_to_dlq",
            json!({
                "queue": consumer.queue,
                "dlq": log_entry.target,
                "msg_id": log_entry.msg_id,
                "attempts": log_entry.attempts,
                "max_retries": consumer.max_retries,
                "reason": reason,
            }),
        );
    }
    for log_entry in invalid_attempt_logs {
        log(
            state,
            LogLevel::Warn,
            "queue_message_invalid_attempts",
            json!({
                "queue": consumer.queue,
                "msg_id": log_entry.msg_id,
                "stream_id": log_entry.stream_id,
                "attempts": log_entry.attempts,
            }),
        );
    }
    record_queue_messages(&state.metrics, "dlq", dlq_count);
    Ok(())
}

pub(crate) fn build_retry_batch_plan(
    retries: Vec<(QueueMessage, i64)>,
    stream_key: &str,
    consumer: &Consumer,
    max_dlq_len: usize,
    now: i64,
) -> SchedulerResult<RetryBatchPlan> {
    let stream_key_owned = stream_key.to_string();
    let mut pipe = redis::pipe();
    pipe.atomic();
    let mut retry_count = 0_usize;
    let mut dlq_count = 0_usize;
    let mut delayed_keys = HashSet::new();
    let mut dlq_logs = Vec::new();
    let mut invalid_attempt_logs = Vec::new();

    for (msg, delay_secs) in retries {
        if !valid_attempts(&msg.attempts) {
            invalid_attempt_logs.push(InvalidAttemptLog {
                msg_id: msg.id.clone(),
                stream_id: msg.stream_id.clone(),
                attempts: msg.attempts.clone(),
            });
        }
        match decide_retry_action(
            &msg,
            delay_secs,
            consumer.max_retries,
            consumer.dead_letter_queue.as_deref(),
            &consumer.queue,
            now,
        ) {
            RetryAction::Dlq {
                attempts,
                target,
                entry,
            } => {
                let dlq_key = queue_dlq_key(&consumer.ns, &target);
                pipe_xadd_entry(&mut pipe, &dlq_key, Some(max_dlq_len), &entry);
                pipe_xack_xdel(&mut pipe, &stream_key_owned, &msg.stream_id);
                dlq_count += 1;
                dlq_logs.push(DlqLog {
                    target,
                    msg_id: msg.id,
                    attempts,
                });
            }
            RetryAction::Delay {
                visible_at_ms,
                entry,
            } => {
                let delayed_key = queue_delayed_key(&consumer.ns, &consumer.queue);
                let member = serde_json::to_string(&entry)?;
                pipe.cmd("ZADD")
                    .arg(&delayed_key)
                    .arg(visible_at_ms)
                    .arg(member);
                pipe.cmd("SADD")
                    .arg(QUEUE_DELAYED_INDEX_KEY)
                    .arg(&delayed_key);
                pipe_xack_xdel(&mut pipe, &stream_key_owned, &msg.stream_id);
                delayed_keys.insert(delayed_key);
                retry_count += 1;
            }
            RetryAction::Immediate { entry } => {
                pipe_xadd_entry(&mut pipe, &stream_key_owned, None, &entry);
                pipe_xack_xdel(&mut pipe, &stream_key_owned, &msg.stream_id);
                retry_count += 1;
            }
        }
    }

    Ok(RetryBatchPlan {
        pipe,
        retry_count,
        dlq_count,
        delayed_keys,
        dlq_logs,
        invalid_attempt_logs,
    })
}

pub(crate) fn build_terminal_batch_plan(
    messages: Vec<QueueMessage>,
    stream_key: &str,
    consumer: &Consumer,
    max_dlq_len: usize,
    reason: &str,
) -> SchedulerResult<RetryBatchPlan> {
    let stream_key_owned = stream_key.to_string();
    let mut pipe = redis::pipe();
    pipe.atomic();
    let mut dlq_count = 0_usize;
    let mut dlq_logs = Vec::new();
    let mut invalid_attempt_logs = Vec::new();

    for msg in messages {
        if !valid_attempts(&msg.attempts) {
            invalid_attempt_logs.push(InvalidAttemptLog {
                msg_id: msg.id.clone(),
                stream_id: msg.stream_id.clone(),
                attempts: msg.attempts.clone(),
            });
        }
        let attempts = parse_next_attempts(&msg.attempts);
        let entry = HashMap::from([
            ("id".to_string(), msg.id.clone()),
            ("body_b64".to_string(), msg.body_b64.clone()),
            ("content_type".to_string(), msg.content_type.clone()),
            ("attempts".to_string(), attempts.to_string()),
            ("first_seen_ms".to_string(), msg.first_seen_ms.clone()),
            ("reason".to_string(), reason.to_string()),
        ]);
        let target = consumer
            .dead_letter_queue
            .as_deref()
            .unwrap_or(&consumer.queue)
            .to_string();
        let dlq_key = queue_dlq_key(&consumer.ns, &target);
        pipe_xadd_entry(&mut pipe, &dlq_key, Some(max_dlq_len), &entry);
        pipe_xack_xdel(&mut pipe, &stream_key_owned, &msg.stream_id);
        dlq_count += 1;
        dlq_logs.push(DlqLog {
            target,
            msg_id: msg.id,
            attempts,
        });
    }

    Ok(RetryBatchPlan {
        pipe,
        retry_count: 0,
        dlq_count,
        delayed_keys: HashSet::new(),
        dlq_logs,
        invalid_attempt_logs,
    })
}

pub(crate) fn record_queue_messages(metrics: &Metrics, outcome: &str, count: usize) {
    if count == 0 {
        return;
    }
    metrics.increment(
        "queue_messages",
        &[("service", SERVICE), ("outcome", outcome)],
        count as f64,
    );
}

pub(crate) fn record_queue_dispatch_failures(metrics: &Metrics, kind: &str, count: usize) {
    if count == 0 {
        return;
    }
    metrics.increment(
        "queue_dispatch_failures",
        &[("service", SERVICE), ("kind", kind)],
        count as f64,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, stream_id: &str, attempts: &str) -> QueueMessage {
        QueueMessage {
            stream_id: stream_id.to_string(),
            id: id.to_string(),
            body_b64: "aGVsbG8=".to_string(),
            content_type: "text".to_string(),
            attempts: attempts.to_string(),
            first_seen_ms: "1699999999999".to_string(),
        }
    }

    fn parse_packed_commands(packed: &[u8]) -> Vec<Vec<String>> {
        let mut offset = 0_usize;
        let mut commands = Vec::new();
        while offset < packed.len() {
            assert_eq!(packed[offset], b'*');
            offset += 1;
            let count = read_resp_usize(packed, &mut offset);
            let mut command = Vec::new();
            for _ in 0..count {
                assert_eq!(packed[offset], b'$');
                offset += 1;
                let len = read_resp_usize(packed, &mut offset);
                let end = offset + len;
                command.push(String::from_utf8(packed[offset..end].to_vec()).unwrap());
                offset = end;
                assert_eq!(&packed[offset..offset + 2], b"\r\n");
                offset += 2;
            }
            commands.push(command);
        }
        commands
    }

    fn read_resp_usize(packed: &[u8], offset: &mut usize) -> usize {
        let start = *offset;
        while &packed[*offset..*offset + 2] != b"\r\n" {
            *offset += 1;
        }
        let value = std::str::from_utf8(&packed[start..*offset])
            .unwrap()
            .parse::<usize>()
            .unwrap();
        *offset += 2;
        value
    }

    #[test]
    fn queue_message_metric_counts_messages_not_batches() {
        let metrics = Metrics::default();
        record_queue_messages(&metrics, "ack", 3);
        record_queue_messages(&metrics, "retry", 1);
        record_queue_messages(&metrics, "ack", 2);
        record_queue_messages(&metrics, "dlq", 0);

        let rendered = metrics.render_prometheus();
        assert!(
            rendered.contains("wdl_queue_messages_total{outcome=\"ack\",service=\"scheduler\"} 5")
        );
        assert!(
            rendered
                .contains("wdl_queue_messages_total{outcome=\"retry\",service=\"scheduler\"} 1")
        );
        assert!(!rendered.contains("outcome=\"dlq\""));
    }

    #[test]
    fn queue_dispatch_failure_metric_is_separate_from_message_outcomes() {
        let metrics = Metrics::default();
        record_queue_dispatch_failures(&metrics, "transport_error", 2);
        record_queue_dispatch_failures(&metrics, "handler_error", 3);
        record_queue_dispatch_failures(&metrics, "handler_error", 0);

        let rendered = metrics.render_prometheus();
        assert!(rendered.contains(
            "wdl_queue_dispatch_failures_total{kind=\"transport_error\",service=\"scheduler\"} 2"
        ));
        assert!(rendered.contains(
            "wdl_queue_dispatch_failures_total{kind=\"handler_error\",service=\"scheduler\"} 3"
        ));
        assert!(!rendered.contains("wdl_queue_messages_total"));
    }

    #[test]
    fn decide_retry_action_preserves_off_by_one_retry_contract() {
        match decide_retry_action(&msg("a", "1-0", "0"), 0, 3, None, "jobs", 0) {
            RetryAction::Immediate { entry } => {
                assert_eq!(entry.get("attempts").map(String::as_str), Some("1"));
                assert!(!entry.contains_key("reason"));
            }
            _ => panic!("expected immediate retry"),
        }
        match decide_retry_action(&msg("a", "1-0", "2"), 0, 3, None, "jobs", 0) {
            RetryAction::Immediate { entry } => {
                assert_eq!(entry.get("attempts").map(String::as_str), Some("3"));
            }
            _ => panic!("expected retry at attempts=3"),
        }
        match decide_retry_action(&msg("a", "1-0", "3"), 0, 3, None, "jobs", 0) {
            RetryAction::Dlq {
                attempts,
                target,
                entry,
            } => {
                assert_eq!(attempts, 4);
                assert_eq!(target, "jobs");
                assert_eq!(
                    entry.get("reason").map(String::as_str),
                    Some("max_retries_exceeded")
                );
            }
            _ => panic!("expected DLQ after max retries exceeded"),
        }
    }

    #[test]
    fn decide_retry_action_handles_delay_dlq_override_invalid_attempts_and_zero_max() {
        match decide_retry_action(&msg("a", "1-0", "0"), 15, 3, None, "jobs", 1_000_000) {
            RetryAction::Delay {
                visible_at_ms,
                entry,
            } => {
                assert_eq!(visible_at_ms, 1_015_000);
                assert!(!entry.contains_key("reason"));
            }
            _ => panic!("expected delayed retry"),
        }

        match decide_retry_action(&msg("a", "1-0", "99"), 0, 3, Some("failures"), "jobs", 0) {
            RetryAction::Dlq { target, entry, .. } => {
                assert_eq!(target, "failures");
                assert_eq!(entry.get("id").map(String::as_str), Some("a"));
                assert_eq!(entry.get("body_b64").map(String::as_str), Some("aGVsbG8="));
                assert_eq!(entry.get("content_type").map(String::as_str), Some("text"));
                assert_eq!(
                    entry.get("first_seen_ms").map(String::as_str),
                    Some("1699999999999")
                );
            }
            _ => panic!("expected explicit DLQ target"),
        }

        match decide_retry_action(&msg("a", "1-0", "bogus"), 0, 3, None, "jobs", 0) {
            RetryAction::Immediate { entry } => {
                assert_eq!(entry.get("attempts").map(String::as_str), Some("1"));
            }
            _ => panic!("expected invalid attempts to start at 1"),
        }

        match decide_retry_action(&msg("a", "1-0", "-1"), 0, 3, None, "jobs", 0) {
            RetryAction::Immediate { entry } => {
                assert_eq!(entry.get("attempts").map(String::as_str), Some("1"));
            }
            _ => panic!("expected negative attempts to start at 1"),
        }

        match decide_retry_action(
            &msg("a", "1-0", &i64::MAX.to_string()),
            0,
            3,
            None,
            "jobs",
            0,
        ) {
            RetryAction::Immediate { entry } => {
                assert_eq!(entry.get("attempts").map(String::as_str), Some("1"));
            }
            _ => panic!("expected overflow attempts to start at 1"),
        }

        match decide_retry_action(&msg("a", "1-0", "0"), 0, 0, None, "jobs", 0) {
            RetryAction::Dlq { attempts, .. } => assert_eq!(attempts, 1),
            _ => panic!("expected max_retries=0 to DLQ first failure"),
        }
    }

    #[test]
    fn decide_retry_action_clamps_large_delays_and_saturates_visible_time() {
        match decide_retry_action(&msg("a", "1-0", "0"), i64::MAX, 3, None, "jobs", 1_000_000) {
            RetryAction::Delay { visible_at_ms, .. } => {
                assert_eq!(
                    visible_at_ms,
                    1_000_000 + MAX_QUEUE_DELAY_SECONDS * MILLIS_PER_SECOND
                );
            }
            _ => panic!("expected oversized delay to be clamped into delayed retry"),
        }

        match decide_retry_action(&msg("a", "1-0", "0"), 5, 3, None, "jobs", i64::MAX - 1) {
            RetryAction::Delay { visible_at_ms, .. } => {
                assert_eq!(visible_at_ms, i64::MAX);
            }
            _ => panic!("expected visible_at_ms to saturate at i64::MAX"),
        }

        match decide_retry_action(&msg("a", "1-0", "0"), -1, 3, None, "jobs", 1_000_000) {
            RetryAction::Immediate { .. } => {}
            _ => panic!("expected negative delay to remain immediate retry"),
        }
    }

    #[test]
    fn retry_batch_plan_clamps_worker_controlled_retry_delays() {
        let consumer = Consumer {
            ns: "demo".to_string(),
            queue: "jobs".to_string(),
            max_batch_size: 10,
            max_batch_timeout_ms: 5000,
            max_retries: 3,
            retry_delay_secs: 0,
            dead_letter_queue: None,
            worker_id: "demo:worker:v1".to_string(),
        };
        let plan = build_retry_batch_plan(
            vec![(msg("huge", "9-0", "0"), i64::MAX)],
            "queue:demo:jobs:s",
            &consumer,
            99,
            1_000_000,
        )
        .unwrap();

        let commands = parse_packed_commands(&plan.pipe.get_packed_pipeline());
        assert_eq!(commands[1][0], "ZADD");
        assert_eq!(
            commands[1][2],
            (1_000_000 + MAX_QUEUE_DELAY_SECONDS * MILLIS_PER_SECOND).to_string()
        );
    }

    #[test]
    fn retry_batch_plan_builds_one_atomic_pipeline_for_mixed_actions() {
        let consumer = Consumer {
            ns: "demo".to_string(),
            queue: "jobs".to_string(),
            max_batch_size: 10,
            max_batch_timeout_ms: 5000,
            max_retries: 1,
            retry_delay_secs: 0,
            dead_letter_queue: Some("failures".to_string()),
            worker_id: "demo:worker:v1".to_string(),
        };
        let plan = build_retry_batch_plan(
            vec![
                (msg("immediate", "1-0", "0"), 0),
                (msg("delayed", "2-0", "0"), 7),
                (msg("dead", "3-0", "1"), 0),
            ],
            "queue:demo:jobs:s",
            &consumer,
            99,
            1_000_000,
        )
        .unwrap();

        assert_eq!(plan.retry_count, 2);
        assert_eq!(plan.dlq_count, 1);
        assert!(plan.delayed_keys.contains("queue-delayed:demo:jobs"));
        assert_eq!(plan.dlq_logs.len(), 1);
        assert_eq!(plan.dlq_logs[0].target, "failures");
        assert_eq!(plan.dlq_logs[0].msg_id, "dead");
        assert_eq!(plan.dlq_logs[0].attempts, 2);
        assert!(plan.invalid_attempt_logs.is_empty());

        let commands = parse_packed_commands(&plan.pipe.get_packed_pipeline());
        let names = commands
            .iter()
            .map(|cmd| cmd[0].as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "MULTI", "XADD", "XACK", "XDEL", "ZADD", "SADD", "XACK", "XDEL", "XADD", "XACK",
                "XDEL", "EXEC"
            ]
        );
        assert_eq!(commands[1][1], "queue:demo:jobs:s");
        assert_eq!(
            commands[2],
            ["XACK", "queue:demo:jobs:s", CONSUMER_GROUP, "1-0"]
        );
        assert_eq!(commands[3], ["XDEL", "queue:demo:jobs:s", "1-0"]);
        assert_eq!(commands[4][1], "queue-delayed:demo:jobs");
        assert_eq!(commands[4][2], "1007000");
        assert_eq!(
            commands[5],
            ["SADD", QUEUE_DELAYED_INDEX_KEY, "queue-delayed:demo:jobs"]
        );
        assert_eq!(
            commands[6],
            ["XACK", "queue:demo:jobs:s", CONSUMER_GROUP, "2-0"]
        );
        assert_eq!(commands[7], ["XDEL", "queue:demo:jobs:s", "2-0"]);
        assert_eq!(
            &commands[8][0..5],
            ["XADD", "queue:demo:failures:dlq", "MAXLEN", "~", "99"]
        );
        assert_eq!(
            commands[9],
            ["XACK", "queue:demo:jobs:s", CONSUMER_GROUP, "3-0"]
        );
        assert_eq!(commands[10], ["XDEL", "queue:demo:jobs:s", "3-0"]);
    }

    #[test]
    fn retry_batch_plan_records_invalid_attempts_for_warning_logs() {
        let consumer = Consumer {
            ns: "demo".to_string(),
            queue: "jobs".to_string(),
            max_batch_size: 10,
            max_batch_timeout_ms: 5000,
            max_retries: 3,
            retry_delay_secs: 0,
            dead_letter_queue: None,
            worker_id: "demo:worker:v1".to_string(),
        };
        let plan = build_retry_batch_plan(
            vec![(msg("bad", "9-0", "not-a-number"), 0)],
            "queue:demo:jobs:s",
            &consumer,
            99,
            1_000_000,
        )
        .unwrap();

        assert_eq!(plan.retry_count, 1);
        assert_eq!(plan.dlq_count, 0);
        assert_eq!(plan.invalid_attempt_logs.len(), 1);
        assert_eq!(plan.invalid_attempt_logs[0].msg_id, "bad");
        assert_eq!(plan.invalid_attempt_logs[0].stream_id, "9-0");
        assert_eq!(plan.invalid_attempt_logs[0].attempts, "not-a-number");

        let commands = parse_packed_commands(&plan.pipe.get_packed_pipeline());
        assert_eq!(commands[1][1], "queue:demo:jobs:s");
        assert!(
            commands[1]
                .array_windows::<2>()
                .any(|pair| pair[0] == "attempts" && pair[1] == "1")
        );

        let negative_plan = build_retry_batch_plan(
            vec![(msg("negative", "10-0", "-1"), 0)],
            "queue:demo:jobs:s",
            &consumer,
            99,
            1_000_000,
        )
        .unwrap();
        assert_eq!(negative_plan.invalid_attempt_logs.len(), 1);
        assert_eq!(negative_plan.invalid_attempt_logs[0].attempts, "-1");

        let overflow_plan = build_retry_batch_plan(
            vec![(msg("overflow", "11-0", &i64::MAX.to_string()), 0)],
            "queue:demo:jobs:s",
            &consumer,
            99,
            1_000_000,
        )
        .unwrap();
        assert_eq!(overflow_plan.invalid_attempt_logs.len(), 1);
        assert_eq!(
            overflow_plan.invalid_attempt_logs[0].attempts,
            i64::MAX.to_string()
        );
    }

    #[test]
    fn terminal_batch_plan_sends_messages_directly_to_dlq_with_reason() {
        let consumer = Consumer {
            ns: "demo".to_string(),
            queue: "jobs".to_string(),
            max_batch_size: 10,
            max_batch_timeout_ms: 5000,
            max_retries: 3,
            retry_delay_secs: 0,
            dead_letter_queue: Some("failures".to_string()),
            worker_id: "demo:worker:v1".to_string(),
        };
        let plan = build_terminal_batch_plan(
            vec![(msg("bad", "9-0", "0"))],
            "queue:demo:jobs:s",
            &consumer,
            99,
            "queue_message_decode_failed",
        )
        .unwrap();

        assert_eq!(plan.retry_count, 0);
        assert_eq!(plan.dlq_count, 1);
        assert_eq!(plan.dlq_logs[0].target, "failures");
        assert_eq!(plan.dlq_logs[0].msg_id, "bad");
        assert_eq!(plan.dlq_logs[0].attempts, 1);

        let commands = parse_packed_commands(&plan.pipe.get_packed_pipeline());
        assert_eq!(
            &commands[1][0..5],
            ["XADD", "queue:demo:failures:dlq", "MAXLEN", "~", "99"]
        );
        assert!(
            commands[1]
                .array_windows::<2>()
                .any(|pair| pair[0] == "reason" && pair[1] == "queue_message_decode_failed")
        );
        assert_eq!(
            commands[2],
            ["XACK", "queue:demo:jobs:s", CONSUMER_GROUP, "9-0"]
        );
        assert_eq!(commands[3], ["XDEL", "queue:demo:jobs:s", "9-0"]);
    }
}
