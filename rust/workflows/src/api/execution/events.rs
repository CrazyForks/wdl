use serde_json::{Value as JsonValue, json};
use wdl_rust_common::time::now_ms;

use crate::{
    AppState, EventRecord, WorkflowError, WorkflowRequest, WorkflowResult, ready_active_key,
};

use super::super::{
    InstanceRouteKeys, aggregate_payload_error, eval_script, event_payload_json,
    event_type_from_value, instance_id, instance_payload_limit_arg, read_public_state, result_json,
    spawn_progress_from_step, validate_identity,
};
use super::{
    StepRecord, StepRecordCommit, WorkflowStepRequest, commit_step_record, inline_step_payload,
    log_step_event, observe_step_duration, read_step_record_for_claim, step_event_ref,
    step_record_json, step_summary_json, validate_step_request, verify_step_record,
    write_waiting_record,
};

pub(crate) const SEND_EVENT_SCRIPT: &str = r#"
local status = redis.call("HGET", KEYS[1], "status")
if not status then
  return 0
end
if status == "completed" or status == "failed" or status == "terminated" then
  return -2
end
local generation = redis.call("HGET", KEYS[1], "generation")
if generation ~= ARGV[6] then
  return -3
end
local payload_bytes = tonumber(redis.call("HGET", KEYS[1], "payloadBytes") or "0")
local current_event_seq = tonumber(redis.call("HGET", KEYS[1], "eventSeq") or "0")
local event_id = tostring(current_event_seq + 1)
local payload_ref = "event:" .. event_id
local record_json = cjson.encode({
  id = event_id,
  type = ARGV[2],
  payloadRef = payload_ref,
  createdAtMs = tonumber(ARGV[3])
})
local next_payload_bytes = payload_bytes + string.len(ARGV[1]) + string.len(record_json)
if next_payload_bytes > tonumber(ARGV[5]) then
  return -1
end
redis.call("HSET", KEYS[2], payload_ref, ARGV[1])
redis.call("HSET", KEYS[3], event_id, record_json)
redis.call("ZADD", KEYS[6], 0, ARGV[8] .. string.format("%020d", tonumber(event_id)))
redis.call("HSET", KEYS[1], "updatedAtMs", ARGV[3], "payloadBytes", tostring(next_payload_bytes), "eventSeq", event_id)
if status ~= "paused" then
  redis.call("SADD", KEYS[4], ARGV[4])
  redis.call("SADD", KEYS[5], ARGV[7])
end
return 1
"#;

const EVENT_INDEX_SCAN_BATCH_SIZE: i64 = 64;
const EVENT_INDEX_STALE_SCAN_LIMIT: usize = 256;

fn wait_event_type(req: &WorkflowStepRequest) -> WorkflowResult<&str> {
    let event_type = req
        .config
        .get("eventType")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| WorkflowError::invalid_request("waitForEvent eventType is required"))?;
    if event_type.is_empty() {
        return Err(WorkflowError::invalid_request(
            "waitForEvent eventType must be non-empty",
        ));
    }
    Ok(event_type)
}

fn event_type_index_prefix(event_type: &str) -> String {
    let mut out = String::with_capacity(event_type.len() * 2 + 1);
    for byte in event_type.as_bytes() {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("hex writes to string");
    }
    out.push(':');
    out
}

fn event_type_index_member(event_type: &str, event_id: &str) -> String {
    let seq = event_id.parse::<u64>().unwrap_or(0);
    format!("{}{seq:020}", event_type_index_prefix(event_type))
}

fn event_id_from_index_member(member: &str) -> Option<String> {
    let raw = member.rsplit_once(':')?.1;
    if raw.len() != 20 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let trimmed = raw.trim_start_matches('0');
    Some(if trimmed.is_empty() { "0" } else { trimmed }.to_string())
}

fn wait_due_at_ms(req: &WorkflowStepRequest) -> WorkflowResult<Option<i64>> {
    match req.due_at_ms {
        Some(due_at_ms) => {
            if due_at_ms <= 0 {
                return Err(WorkflowError::invalid_request(
                    "dueAtMs must be a positive integer",
                ));
            }
            Ok(Some(due_at_ms))
        }
        None => Ok(None),
    }
}

async fn find_buffered_event(
    state: &AppState,
    req: &WorkflowStepRequest,
    event_type: &str,
) -> WorkflowResult<Option<(String, EventRecord, JsonValue)>> {
    let keys = InstanceRouteKeys::new(&req.ns, &req.workflow_key, &req.instance_id);
    let events_key = keys.events();
    let event_index_key = keys.event_type_index();
    let payloads_key = keys.payloads();
    let prefix = event_type_index_prefix(event_type);
    let min = format!("[{prefix}");
    let max = format!("[{prefix}~");
    let mut stale_seen = 0usize;
    loop {
        let members: Vec<String> = state
            .redis
            .with_conn(async |mut conn| {
                redis::cmd("ZRANGEBYLEX")
                    .arg(&event_index_key)
                    .arg(&min)
                    .arg(&max)
                    .arg("LIMIT")
                    .arg(0)
                    .arg(EVENT_INDEX_SCAN_BATCH_SIZE)
                    .query_async(&mut conn)
                    .await
            })
            .await?;
        if members.is_empty() {
            return Ok(None);
        }
        let mut candidates = Vec::with_capacity(members.len());
        let mut stale_members = Vec::new();
        for member in members {
            if let Some(event_id) = event_id_from_index_member(&member) {
                candidates.push((member, event_id));
            } else {
                stale_members.push(member);
            }
        }
        if candidates.is_empty() {
            stale_seen += stale_members.len();
            remove_event_index_members(state, &event_index_key, &stale_members).await?;
            if stale_seen >= EVENT_INDEX_STALE_SCAN_LIMIT {
                return Err(WorkflowError::invalid_state(
                    "Workflow event type index has too many stale members",
                ));
            }
            continue;
        }
        let raw: Vec<Option<String>> = state
            .redis
            .with_conn(async |mut conn| {
                let mut cmd = redis::cmd("HMGET");
                cmd.arg(&events_key);
                for (_, field) in &candidates {
                    cmd.arg(field);
                }
                cmd.query_async(&mut conn).await
            })
            .await?;
        for ((member, field), value) in candidates.into_iter().zip(raw) {
            let Some(value) = value else {
                stale_members.push(member);
                continue;
            };
            let record: EventRecord = serde_json::from_str(&value).map_err(|err| {
                WorkflowError::invalid_state(format!("Workflow event record is corrupt: {err}"))
            })?;
            if record.event_type != event_type || record.consumed_by_ordinal.is_some() {
                stale_members.push(member);
                continue;
            }
            let payload_ref = record.payload_ref.clone();
            let payload_raw: Option<String> = state
                .redis
                .with_conn(async |mut conn| {
                    redis::cmd("HGET")
                        .arg(&payloads_key)
                        .arg(&payload_ref)
                        .query_async(&mut conn)
                        .await
                })
                .await?;
            let Some(payload_raw) = payload_raw else {
                return Err(WorkflowError::payload_missing(format!(
                    "Workflow event payload {payload_ref} is missing"
                )));
            };
            let payload: JsonValue = serde_json::from_str(&payload_raw).map_err(|err| {
                WorkflowError::invalid_state(format!("Workflow event payload is corrupt: {err}"))
            })?;
            remove_event_index_members(state, &event_index_key, &stale_members).await?;
            return Ok(Some((field, record, payload)));
        }
        stale_seen += stale_members.len();
        remove_event_index_members(state, &event_index_key, &stale_members).await?;
        if stale_seen >= EVENT_INDEX_STALE_SCAN_LIMIT {
            return Err(WorkflowError::invalid_state(
                "Workflow event type index has too many stale members",
            ));
        }
    }
}

async fn remove_event_index_members(
    state: &AppState,
    event_index_key: &str,
    members: &[String],
) -> WorkflowResult<()> {
    if members.is_empty() {
        return Ok(());
    }
    let _: i64 = state
        .redis
        .with_conn(async |mut conn| {
            let mut cmd = redis::cmd("ZREM");
            cmd.arg(event_index_key);
            for member in members {
                cmd.arg(member);
            }
            cmd.query_async(&mut conn).await
        })
        .await?;
    Ok(())
}

async fn complete_wait_with_payload(
    state: &AppState,
    req: &WorkflowStepRequest,
    config: String,
    event_field: Option<String>,
    mut event_record: Option<EventRecord>,
    output: JsonValue,
) -> WorkflowResult<JsonValue> {
    let now = now_ms();
    let output_json = result_json(&output, "wait output")?;
    let output_inline = inline_step_payload(&output, &output_json);
    let output_ref = output_inline.is_none().then(|| step_event_ref(req.ordinal));
    let record = StepRecord {
        ordinal: req.ordinal,
        step_name: req.step_name.clone(),
        name_count: req.name_count,
        dependencies: req.dependencies.clone(),
        config,
        status: "completed".to_string(),
        attempt: 1,
        output_ref: output_ref.clone(),
        error_ref: None,
        output: output_inline,
        error: None,
        completed_at_ms: Some(now),
        failed_at_ms: None,
        due_at_ms: None,
    };
    let record_json = step_record_json(&record)?;
    let summary_json = step_summary_json(&record)?;
    if let Some(record) = event_record.as_mut() {
        record.consumed_by_ordinal = Some(req.ordinal);
    }
    let event_index_member = event_record
        .as_ref()
        .map(|record| event_type_index_member(&record.event_type, &record.id));
    let event_json = event_record
        .map(|record| {
            serde_json::to_string(&record).map_err(|err| {
                WorkflowError::internal_error(format!(
                    "Workflow event record serialization failed: {err}"
                ))
            })
        })
        .transpose()?;
    let event_record = match (event_field.as_deref(), event_json) {
        (Some(field), Some(value)) => Some((field, value)),
        _ => None,
    };
    commit_step_record(
        state,
        req,
        StepRecordCommit {
            record_json,
            summary_json,
            state_status: "running",
            due_at_ms: None,
            payload_ref: output_ref.as_deref(),
            payload_json: Some(output_json),
            event_record,
            event_index_member,
            waiting_event_index_prefix: None,
        },
    )
    .await?;
    state
        .metrics
        .increment("workflow_steps", &[("outcome", "completed")], 1.0);
    observe_step_duration(state, req, now);
    log_step_event(state, "workflow_step_completed", req, 1);
    spawn_progress_from_step(state, req, "workflow_step_completed", "completed", 1);
    Ok(json!({ "state": "complete", "output": output }))
}

async fn write_waiting_record_and_recheck_event(
    state: &AppState,
    req: &WorkflowStepRequest,
    config: String,
    record: StepRecord,
    due_at_ms: Option<i64>,
    event_type: &str,
) -> WorkflowResult<JsonValue> {
    write_waiting_record(
        state,
        req,
        record,
        due_at_ms,
        Some(event_type_index_prefix(event_type)),
    )
    .await?;
    if let Some((event_field, event_record, payload)) =
        find_buffered_event(state, req, event_type).await?
    {
        return complete_wait_with_payload(
            state,
            req,
            config,
            Some(event_field),
            Some(event_record),
            payload,
        )
        .await;
    }
    Ok(json!({ "state": "waiting" }))
}

pub(crate) async fn register_wait(
    state: &AppState,
    req: WorkflowStepRequest,
) -> WorkflowResult<JsonValue> {
    let config = validate_step_request(&req)?;
    let event_type = wait_event_type(&req)?.to_string();
    let due_at_ms = wait_due_at_ms(&req)?;
    let raw = read_step_record_for_claim(state, &req).await?;
    let now = now_ms();
    if let Some(raw) = raw {
        let record: StepRecord = serde_json::from_str(&raw).map_err(|err| {
            WorkflowError::invalid_state(format!("Workflow wait step record is corrupt: {err}"))
        })?;
        verify_step_record(&req, &config, &record)?;
        match record.status.as_str() {
            "completed" => {
                let output = if let Some(output) = record.output {
                    output
                } else {
                    let Some(output_ref) = record.output_ref else {
                        return Err(WorkflowError::invalid_state(
                            "Workflow completed wait step is missing output ref",
                        ));
                    };
                    let payloads_key =
                        InstanceRouteKeys::new(&req.ns, &req.workflow_key, &req.instance_id)
                            .payloads();
                    let output_raw: Option<String> = state
                        .redis
                        .with_conn(async |mut conn| {
                            redis::cmd("HGET")
                                .arg(payloads_key)
                                .arg(&output_ref)
                                .query_async(&mut conn)
                                .await
                        })
                        .await?;
                    let Some(output_raw) = output_raw else {
                        return Err(WorkflowError::payload_missing(format!(
                            "Workflow wait output payload {output_ref} is missing"
                        )));
                    };
                    serde_json::from_str(&output_raw).map_err(|err| {
                        WorkflowError::invalid_state(format!(
                            "Workflow wait output is corrupt: {err}"
                        ))
                    })?
                };
                return Ok(json!({ "state": "complete", "output": output }));
            }
            "waiting" => {
                if let Some((event_field, event_record, payload)) =
                    find_buffered_event(state, &req, &event_type).await?
                {
                    return complete_wait_with_payload(
                        state,
                        &req,
                        config,
                        Some(event_field),
                        Some(event_record),
                        payload,
                    )
                    .await;
                }
                if let Some(stored_due) = record.due_at_ms
                    && stored_due <= now
                {
                    return complete_wait_with_payload(
                        state,
                        &req,
                        config,
                        None,
                        None,
                        JsonValue::Null,
                    )
                    .await;
                }
                if let Some(stored_due) = record.due_at_ms {
                    return write_waiting_record_and_recheck_event(
                        state,
                        &req,
                        config,
                        record,
                        Some(stored_due),
                        &event_type,
                    )
                    .await;
                }
                return write_waiting_record_and_recheck_event(
                    state,
                    &req,
                    config,
                    record,
                    None,
                    &event_type,
                )
                .await;
            }
            _ => {
                return Err(WorkflowError::invalid_state(
                    "Workflow wait step is not waiting or completed",
                ));
            }
        }
    }

    if let Some((event_field, event_record, payload)) =
        find_buffered_event(state, &req, &event_type).await?
    {
        return complete_wait_with_payload(
            state,
            &req,
            config,
            Some(event_field),
            Some(event_record),
            payload,
        )
        .await;
    }

    if due_at_ms.is_some_and(|due| due <= now) {
        return complete_wait_with_payload(state, &req, config, None, None, JsonValue::Null).await;
    }

    let waiting = StepRecord {
        ordinal: req.ordinal,
        step_name: req.step_name.clone(),
        name_count: req.name_count,
        dependencies: req.dependencies.clone(),
        config: config.clone(),
        status: "waiting".to_string(),
        attempt: 1,
        output_ref: None,
        error_ref: None,
        output: None,
        error: None,
        completed_at_ms: None,
        failed_at_ms: None,
        due_at_ms,
    };
    write_waiting_record_and_recheck_event(state, &req, config, waiting, due_at_ms, &event_type)
        .await
}

pub(crate) async fn send_event(
    state: &AppState,
    req: WorkflowRequest,
) -> WorkflowResult<JsonValue> {
    validate_identity(&req)?;
    let id = instance_id(&req)?.to_string();
    let event_type = event_type_from_value(&req.event)?.to_string();
    let payload = event_payload_json(&req.event)?;
    let existing = read_public_state(state, &req).await?;
    if existing.is_empty() {
        return Err(WorkflowError::not_found("Workflow instance not found"));
    }
    let status = existing.get("status").map(String::as_str).unwrap_or("");
    if matches!(status, "completed" | "failed" | "terminated") {
        return Err(WorkflowError::invalid_state(
            "Workflow instance is already terminal",
        ));
    }
    let generation = existing
        .get("generation")
        .cloned()
        .ok_or_else(|| WorkflowError::invalid_state("Workflow state missing generation"))?;
    let keys = InstanceRouteKeys::new(&req.ns, &req.workflow_key, &id);
    let state_key = keys.state();
    let payloads_key = keys.payloads();
    let events_key = keys.events();
    let event_index_key = keys.event_type_index();
    let shard = keys.shard();
    let ready = keys.ready();
    let token = keys.token();
    let shard_arg = shard.to_string();
    let event_index_prefix = event_type_index_prefix(&event_type);
    let updated_at = now_ms().to_string();
    let payload_limit = instance_payload_limit_arg();
    let committed: i64 = eval_script(
        state,
        SEND_EVENT_SCRIPT,
        &[
            &state_key,
            &payloads_key,
            &events_key,
            &ready,
            ready_active_key(),
            &event_index_key,
        ],
        &[
            &payload,
            &event_type,
            &updated_at,
            &token,
            &payload_limit,
            &generation,
            &shard_arg,
            &event_index_prefix,
        ],
    )
    .await?;
    match committed {
        1 => {}
        0 => return Err(WorkflowError::not_found("Workflow instance not found")),
        -1 => return Err(aggregate_payload_error()),
        -2 => {
            return Err(WorkflowError::invalid_state(
                "Workflow instance is already terminal",
            ));
        }
        -3 => {
            return Err(WorkflowError::conflict(
                "Workflow generation changed before event delivery",
            ));
        }
        _ => {
            return Err(WorkflowError::internal_error(
                "Workflow event commit failed",
            ));
        }
    }
    Ok(json!({ "state": "queued" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_type_index_members_sort_by_type_then_sequence() {
        assert_eq!(
            event_type_index_prefix("room.ready"),
            "726f6f6d2e7265616479:"
        );
        assert_eq!(
            event_type_index_member("room.ready", "12"),
            "726f6f6d2e7265616479:00000000000000000012"
        );
        assert_eq!(
            event_id_from_index_member("726f6f6d2e7265616479:00000000000000000012").as_deref(),
            Some("12")
        );
    }

    #[test]
    fn wait_for_event_rechecks_after_waiting_commit() {
        let source = include_str!("events.rs");
        let helper = source
            .find("async fn write_waiting_record_and_recheck_event")
            .expect("wait-for-event helper should be present");
        let body = &source[helper..];
        assert!(body.contains("Some(event_type_index_prefix(event_type))"));
        assert!(body.contains("find_buffered_event(state, req, event_type).await?"));
        assert!(body.contains("complete_wait_with_payload("));
        assert!(
            source.contains(
                "write_waiting_record_and_recheck_event(state, &req, config, waiting, due_at_ms, &event_type)"
            ),
            "new waits must close the sendEvent/register-wait lost-wakeup window"
        );
        assert!(
            source
                .matches("write_waiting_record_and_recheck_event(")
                .count()
                >= 4,
            "new and existing waiting records must both recheck buffered events"
        );
    }
}
