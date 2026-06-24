use std::future::Future;

use futures_util::stream::{FuturesUnordered, StreamExt};
use wdl_rust_common::redis_eval::append_eval_cmd;
use wdl_rust_common::time::now_ms;

use crate::{AppState, ShardQueueKeys, WorkflowError, WorkflowResult};

use super::eval_script;

pub(crate) struct ReadyDispatchConfig {
    pub(crate) batch_size: usize,
    pub(crate) concurrency: usize,
    pub(crate) prune_on_error: bool,
}

pub(crate) struct DuePromotionConfig {
    pub(crate) total_limit: usize,
    pub(crate) per_shard_limit: usize,
    pub(crate) scan_overfetch_factor: usize,
}

pub(crate) struct DuePromotionMember {
    pub(crate) member: String,
    pub(crate) extra_keys: Vec<String>,
    pub(crate) extra_args: Vec<String>,
}

pub(crate) struct ReadyMemberOutcome<C> {
    pub(crate) counters: C,
    pub(crate) stop_after_current_batch: bool,
}

impl<C> ReadyMemberOutcome<C> {
    pub(crate) fn new(counters: C) -> Self {
        Self {
            counters,
            stop_after_current_batch: false,
        }
    }

    pub(crate) fn stop_after_current_batch(counters: C) -> Self {
        Self {
            counters,
            stop_after_current_batch: true,
        }
    }
}

pub(crate) struct ReadyDispatchResult<C> {
    pub(crate) counters: C,
    pub(crate) error: Option<WorkflowError>,
}

const PRUNE_READY_SHARD_SCRIPT: &str = r#"
if redis.call("SCARD", KEYS[1]) == 0 then
  redis.call("SREM", KEYS[2], ARGV[1])
  return 1
end
return 0
"#;

pub(crate) const REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT: &str = r#"
if redis.call("EXISTS", KEYS[1]) == 0 then
  redis.call("SREM", KEYS[2], ARGV[1])
  return 1
end
return 0
"#;

pub(crate) fn rotate_active_shards(mut shards: Vec<usize>, seed: usize) -> Vec<usize> {
    shards.sort_unstable();
    shards.dedup();
    let len = shards.len();
    if len > 0 {
        shards.rotate_left(seed % len);
    }
    shards
}

pub(crate) async fn active_ready_shards(
    app: &AppState,
    keys: ShardQueueKeys,
) -> WorkflowResult<Vec<usize>> {
    let (raw, cursor): (Vec<String>, i64) = app
        .redis
        .with_conn(async |mut conn| {
            let mut pipe = redis::pipe();
            pipe.cmd("SMEMBERS")
                .arg(keys.ready_active())
                .cmd("INCR")
                .arg(keys.ready_cursor())
                .query_async(&mut conn)
                .await
        })
        .await?;
    let shards = raw
        .into_iter()
        .filter_map(|value| value.parse::<usize>().ok())
        .filter(|shard| *shard < keys.shard_count())
        .collect::<Vec<_>>();
    Ok(rotate_active_shards(shards, cursor.max(0) as usize))
}

pub(crate) async fn sample_ready_members(
    app: &AppState,
    keys: ShardQueueKeys,
    shard: usize,
    limit: usize,
) -> WorkflowResult<Vec<String>> {
    app.redis
        .with_conn(async |mut conn| {
            redis::cmd("SRANDMEMBER")
                .arg(keys.ready(shard))
                .arg(limit)
                .query_async(&mut conn)
                .await
        })
        .await
        .map_err(Into::into)
}

pub(crate) async fn prune_ready_shard_if_empty(
    app: &AppState,
    keys: ShardQueueKeys,
    shard: usize,
) -> WorkflowResult<()> {
    let ready = keys.ready(shard);
    let shard_arg = shard.to_string();
    eval_script::<i64>(
        app,
        PRUNE_READY_SHARD_SCRIPT,
        &[&ready, keys.ready_active()],
        &[&shard_arg],
    )
    .await?;
    Ok(())
}

pub(crate) async fn remove_ready_member_if_state_missing(
    app: &AppState,
    state_key: &str,
    ready_key: &str,
    member: &str,
) -> WorkflowResult<bool> {
    let removed: i64 = eval_script(
        app,
        REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT,
        &[state_key, ready_key],
        &[member],
    )
    .await?;
    Ok(removed == 1)
}

pub(crate) async fn promote_due_members<F>(
    app: &AppState,
    keys: ShardQueueKeys,
    config: DuePromotionConfig,
    promote_script: &str,
    prepare_member: F,
) -> WorkflowResult<usize>
where
    F: Fn(&str) -> Option<DuePromotionMember> + Copy,
{
    if config.total_limit == 0 || config.per_shard_limit == 0 {
        return Ok(0);
    }
    let now = now_ms();
    let mut moved = 0;
    for shard in due_shards_with_due_members(app, keys, now).await? {
        if moved >= config.total_limit {
            break;
        }
        let due = keys.due(shard);
        let ready = keys.ready(shard);
        let remaining = config.total_limit - moved;
        let scan_count = remaining
            .min(config.per_shard_limit)
            .saturating_mul(config.scan_overfetch_factor.max(1));
        let members: Vec<String> = app
            .redis
            .with_conn(async |mut conn| {
                redis::cmd("ZRANGEBYSCORE")
                    .arg(&due)
                    .arg("-inf")
                    .arg(now)
                    .arg("LIMIT")
                    .arg(0)
                    .arg(scan_count)
                    .query_async(&mut conn)
                    .await
            })
            .await?;
        if members.is_empty() {
            continue;
        }

        let mut candidates = Vec::new();
        let mut malformed = Vec::new();
        for member in members {
            match prepare_member(&member) {
                Some(candidate) => candidates.push(candidate),
                None => malformed.push(member),
            }
        }
        if !malformed.is_empty() {
            app.redis
                .with_conn({
                    let due = due.clone();
                    async move |mut conn| {
                        redis::cmd("ZREM")
                            .arg(due)
                            .arg(malformed)
                            .query_async::<()>(&mut conn)
                            .await
                    }
                })
                .await?;
        }
        if candidates.is_empty() {
            continue;
        }

        let shard_arg = shard.to_string();
        let now_arg = now.to_string();
        let mut offset = 0;
        let mut shard_moved = 0;
        while moved < config.total_limit
            && shard_moved < config.per_shard_limit
            && offset < candidates.len()
        {
            let remaining = (config.total_limit - moved).min(config.per_shard_limit - shard_moved);
            let end = (offset + remaining).min(candidates.len());
            let results: Vec<i64> = app
                .redis
                .with_conn(async |mut conn| {
                    let mut pipe = redis::pipe();
                    for candidate in &candidates[offset..end] {
                        let mut script_keys =
                            vec![due.as_str(), ready.as_str(), keys.ready_active()];
                        script_keys.extend(candidate.extra_keys.iter().map(String::as_str));
                        let mut script_args = vec![
                            candidate.member.as_str(),
                            now_arg.as_str(),
                            shard_arg.as_str(),
                        ];
                        script_args.extend(candidate.extra_args.iter().map(String::as_str));
                        append_eval_cmd(&mut pipe, promote_script, &script_keys, &script_args);
                    }
                    pipe.query_async(&mut conn).await
                })
                .await?;
            let moved_now = results.into_iter().filter(|value| *value == 1).count();
            moved += moved_now;
            shard_moved += moved_now;
            offset = end;
        }
    }
    Ok(moved)
}

pub(crate) async fn due_shards_with_due_members(
    app: &AppState,
    keys: ShardQueueKeys,
    now: i64,
) -> WorkflowResult<Vec<usize>> {
    let pages: Vec<Vec<String>> = app
        .redis
        .with_conn(async |mut conn| {
            let mut pipe = redis::pipe();
            for shard in 0..keys.shard_count() {
                pipe.cmd("ZRANGEBYSCORE")
                    .arg(keys.due(shard))
                    .arg("-inf")
                    .arg(now)
                    .arg("LIMIT")
                    .arg(0)
                    .arg(1);
            }
            pipe.query_async(&mut conn).await
        })
        .await?;
    Ok(pages
        .into_iter()
        .enumerate()
        .filter_map(|(shard, members)| (!members.is_empty()).then_some(shard))
        .collect())
}

pub(crate) async fn dispatch_ready_members<C, F, Fut, D, M>(
    app: &AppState,
    keys: ShardQueueKeys,
    config: ReadyDispatchConfig,
    mut counters: C,
    dispatched_count: D,
    process_member: F,
    mut merge_counters: M,
) -> WorkflowResult<ReadyDispatchResult<C>>
where
    F: Fn(usize, String) -> Fut + Copy,
    Fut: Future<Output = WorkflowResult<ReadyMemberOutcome<C>>>,
    D: Fn(&C) -> usize + Copy,
    M: FnMut(&mut C, C),
{
    let mut tick_error = None;
    let concurrency = config.concurrency.max(1);
    let active_shards = active_ready_shards(app, keys).await?;
    for shard in active_shards {
        if dispatched_count(&counters) >= config.batch_size {
            break;
        }
        let remaining = config.batch_size - dispatched_count(&counters);
        let members = sample_ready_members(app, keys, shard, remaining).await?;
        let mut in_flight = FuturesUnordered::new();
        let mut first_error = None;
        let mut stop_after_current_batch = false;
        for member in members {
            while in_flight.len() >= concurrency {
                let Some(result) = in_flight.next().await else {
                    break;
                };
                apply_ready_member_result(
                    result,
                    &mut counters,
                    &mut first_error,
                    &mut stop_after_current_batch,
                    &mut merge_counters,
                );
            }
            if first_error.is_some() || stop_after_current_batch {
                break;
            }
            in_flight.push(process_member(shard, member));
        }
        while let Some(result) = in_flight.next().await {
            apply_ready_member_result(
                result,
                &mut counters,
                &mut first_error,
                &mut stop_after_current_batch,
                &mut merge_counters,
            );
        }
        if config.prune_on_error || first_error.is_none() {
            prune_ready_shard_if_empty(app, keys, shard).await?;
        }
        if let Some(err) = first_error {
            tick_error = Some(err);
            break;
        }
        if stop_after_current_batch {
            break;
        }
    }
    Ok(ReadyDispatchResult {
        counters,
        error: tick_error,
    })
}

fn apply_ready_member_result<C, M>(
    result: WorkflowResult<ReadyMemberOutcome<C>>,
    counters: &mut C,
    first_error: &mut Option<WorkflowError>,
    stop_after_current_batch: &mut bool,
    merge_counters: &mut M,
) where
    M: FnMut(&mut C, C),
{
    match result {
        Ok(outcome) => {
            merge_counters(counters, outcome.counters);
            *stop_after_current_batch |= outcome.stop_after_current_batch;
        }
        Err(err) => {
            first_error.get_or_insert(err);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_shards_rotate_from_stable_order() {
        assert_eq!(rotate_active_shards(vec![3, 1, 3, 2], 0), vec![1, 2, 3]);
        assert_eq!(rotate_active_shards(vec![3, 1, 3, 2], 1), vec![2, 3, 1]);
        assert_eq!(rotate_active_shards(vec![3, 1, 3, 2], 5), vec![3, 1, 2]);
    }

    #[test]
    fn ready_shard_prune_removes_only_empty_shards_from_active_index() {
        assert!(PRUNE_READY_SHARD_SCRIPT.contains(r#"redis.call("SCARD", KEYS[1]) == 0"#));
        assert!(PRUNE_READY_SHARD_SCRIPT.contains(r#"redis.call("SREM", KEYS[2], ARGV[1])"#));
    }

    #[test]
    fn stale_ready_member_cleanup_rechecks_state_inside_lua() {
        assert!(
            REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT
                .contains(r#"redis.call("EXISTS", KEYS[1]) == 0"#)
        );
        assert!(
            REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT
                .contains(r#"redis.call("SREM", KEYS[2], ARGV[1])"#)
        );
        assert!(REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT.contains("return 1"));
        assert!(REMOVE_READY_MEMBER_IF_STATE_MISSING_SCRIPT.contains("return 0"));
    }

    #[test]
    fn dispatcher_drains_in_flight_before_reporting_first_error() {
        let source = include_str!("sharded_dispatch.rs");
        let implementation = source
            .split("\n#[cfg(test)]")
            .next()
            .expect("dispatcher implementation should precede tests");

        assert!(implementation.contains("let mut first_error = None;"));
        assert!(implementation.contains("while let Some(result) = in_flight.next().await"));
        assert!(implementation.contains("tick_error = Some(err);"));
    }

    #[test]
    fn dispatcher_stops_starting_new_members_after_batch_stop_signal() {
        let source = include_str!("sharded_dispatch.rs");
        let implementation = source
            .split("\n#[cfg(test)]")
            .next()
            .expect("dispatcher implementation should precede tests");
        let stop_check = implementation
            .find("if first_error.is_some() || stop_after_current_batch")
            .expect("dispatcher should stop filling after a stop signal");
        let push = implementation
            .find("in_flight.push(process_member(shard, member));")
            .expect("dispatcher should start work after checking stop conditions");

        assert!(stop_check < push);
    }
}
