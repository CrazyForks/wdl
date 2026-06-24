use serde::Serialize;
use serde_json::{Value as JsonValue, json};
use std::collections::HashMap;

use crate::{
    AppState, InstanceIdentity, LogLevel, WorkflowError, WorkflowResult, fields_with_error, log,
    workflow_shard_queue_keys,
};

use super::{
    ReadyDispatchConfig, ReadyMemberOutcome, claim_run, dispatch_ready_do_alarms,
    dispatch_ready_members, emit_outcome_counts, identity_from_state, log_instance_event,
    parse_ready_token, read_payload_ref, read_state_by_id, release_run_claim,
    requeue_expired_run_claim, spawn_progress_from_identity,
};

mod dispatch;
mod ready;
mod retention;
#[cfg(test)]
pub(crate) use dispatch::COMMIT_RUNTIME_TERMINAL_SCRIPT;
use dispatch::{RuntimeCommitOutcome, commit_runtime_result, dispatch_runtime};
use ready::{
    ReadyTokenGuard, ReadyTokenIdentity, move_due_tokens, remove_ready_token,
    remove_ready_token_if_state_missing, remove_ready_token_if_terminal,
};
use retention::cleanup_retention;

const READY_BATCH_SIZE: usize = 100;
const READY_DISPATCH_CONCURRENCY: usize = 8;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TickResponse {
    pub(crate) dispatched: usize,
    pub(crate) completed: usize,
    pub(crate) failed: usize,
    pub(crate) suspended: usize,
    pub(crate) due_moved: usize,
    pub(crate) retention_cleaned: usize,
    pub(crate) do_alarm_due_moved: usize,
    pub(crate) do_alarm_dispatched: usize,
    pub(crate) do_alarm_delivered: usize,
    pub(crate) do_alarm_retried: usize,
    pub(crate) do_alarm_discarded: usize,
    pub(crate) do_alarm_skipped: usize,
}

#[derive(Default)]
struct TickCounters {
    dispatched: usize,
    completed: usize,
    failed: usize,
    suspended: usize,
}
enum ReadyTokenResult {
    Completed,
    Failed,
    DispatchError,
    Suspended,
    SuspendedKeep,
    RemoveMalformed,
    RemoveIfStateMissing(ReadyTokenIdentity),
    RemoveIfTerminal(ReadyTokenGuard),
    Keep,
}
async fn load_params(app: &AppState, state: &HashMap<String, String>) -> WorkflowResult<JsonValue> {
    Ok(read_payload_ref(app, state, "paramsRef")
        .await?
        .unwrap_or(JsonValue::Null))
}

async fn dispatch_ready_token(
    app: &AppState,
    token: String,
    request_id: Option<&str>,
) -> WorkflowResult<ReadyTokenResult> {
    let Some((ns, workflow_key, instance_id)) = parse_ready_token(&token) else {
        return Ok(ReadyTokenResult::RemoveMalformed);
    };
    let state = read_state_by_id(app, &ns, &workflow_key, &instance_id).await?;
    let Some(status) = state.get("status").map(String::as_str) else {
        return Ok(ReadyTokenResult::RemoveIfStateMissing(ReadyTokenIdentity {
            ns,
            workflow_key,
            instance_id,
        }));
    };
    if status == "running" {
        let identity = identity_from_state(&ns, &workflow_key, &instance_id, &state)?;
        requeue_expired_run_claim(app, &identity).await?;
        return Ok(ReadyTokenResult::Keep);
    }
    if status != "queued" && status != "waiting" {
        return Ok(match status {
            "completed" | "failed" | "terminated" => {
                let identity = identity_from_state(&ns, &workflow_key, &instance_id, &state)?;
                ReadyTokenResult::RemoveIfTerminal(ReadyTokenGuard {
                    ns,
                    workflow_key,
                    instance_id,
                    generation: identity.generation,
                })
            }
            _ => ReadyTokenResult::Keep,
        });
    }
    let identity = identity_from_state(&ns, &workflow_key, &instance_id, &state)?;
    let params = load_params(app, &state).await?;
    let previous_status = status.to_string();
    let Some(claim) = claim_run(app, &identity, &previous_status).await? else {
        return Ok(ReadyTokenResult::Keep);
    };
    log_instance_event(app, "workflow_instance_started", &identity);
    spawn_progress_from_identity(app, &identity, "workflow_instance_started", "running", None);
    app.metrics
        .add_gauge("workflow_dispatch_in_flight", &[], 1.0);
    let response = match dispatch_runtime(app, &identity, &claim.token, params, request_id).await {
        Ok(response) => response,
        Err(err) => {
            app.metrics
                .add_gauge("workflow_dispatch_in_flight", &[], -1.0);
            app.metrics
                .increment("workflow_dispatches", &[("outcome", "error")], 1.0);
            release_run_claim(app, &identity, &claim, &previous_status).await?;
            log_dispatch_error(app, &identity, &err);
            return Ok(ReadyTokenResult::DispatchError);
        }
    };
    let outcome = match commit_runtime_result(app, &identity, &claim, response).await {
        Ok(outcome) => outcome,
        Err(err) => {
            app.metrics
                .add_gauge("workflow_dispatch_in_flight", &[], -1.0);
            app.metrics
                .increment("workflow_dispatches", &[("outcome", "error")], 1.0);
            if err.code == "redis_error" {
                return Err(err);
            }
            release_run_claim(app, &identity, &claim, &previous_status).await?;
            log_dispatch_error(app, &identity, &err);
            return Ok(ReadyTokenResult::DispatchError);
        }
    };
    app.metrics
        .add_gauge("workflow_dispatch_in_flight", &[], -1.0);
    Ok(match outcome {
        RuntimeCommitOutcome::Completed => ReadyTokenResult::Completed,
        RuntimeCommitOutcome::Failed => ReadyTokenResult::Failed,
        RuntimeCommitOutcome::SuspendedRemoveReady => ReadyTokenResult::Suspended,
        RuntimeCommitOutcome::SuspendedKeepReady => ReadyTokenResult::SuspendedKeep,
    })
}

async fn process_ready_workflow_token(
    app: &AppState,
    shard: usize,
    token: String,
    request_id: Option<&str>,
) -> WorkflowResult<ReadyMemberOutcome<TickCounters>> {
    let result = dispatch_ready_token(app, token.clone(), request_id).await?;
    let mut counters = TickCounters::default();
    apply_ready_token_result(app, shard, token, result, &mut counters).await?;
    Ok(ReadyMemberOutcome::new(counters))
}

fn merge_tick_counters(target: &mut TickCounters, delta: TickCounters) {
    target.dispatched += delta.dispatched;
    target.completed += delta.completed;
    target.failed += delta.failed;
    target.suspended += delta.suspended;
}

fn log_dispatch_error(app: &AppState, identity: &InstanceIdentity, err: &WorkflowError) {
    log(
        app,
        LogLevel::Warn,
        "workflow_dispatch_error",
        fields_with_error(
            json!({
                "namespace": identity.ns,
                "worker": identity.worker,
                "workflow_name": identity.workflow_name,
                "workflow_key": identity.workflow_key,
                "workflow_class": identity.class_name,
                "instance_id": identity.instance_id,
                "frozen_version": identity.frozen_version,
                "generation": identity.generation,
                "error_code": err.code,
            }),
            "Error",
            &err.message,
        ),
    );
}

pub(crate) async fn tick_workflows(
    app: &AppState,
    request_id: Option<&str>,
) -> WorkflowResult<TickResponse> {
    let due_moved = move_due_tokens(app).await?;
    let retention_cleaned = cleanup_retention(app).await?;
    let result = dispatch_ready_members(
        app,
        workflow_shard_queue_keys(),
        ReadyDispatchConfig {
            batch_size: READY_BATCH_SIZE,
            concurrency: READY_DISPATCH_CONCURRENCY,
            prune_on_error: false,
        },
        TickCounters::default(),
        |counters| counters.dispatched,
        |shard, token| process_ready_workflow_token(app, shard, token, request_id),
        merge_tick_counters,
    )
    .await?;
    if let Some(err) = result.error {
        return Err(err);
    }
    let counters = result.counters;
    emit_outcome_counts(
        app,
        "workflow_dispatches",
        &[
            ("completed", counters.completed),
            ("failed", counters.failed),
            ("suspended", counters.suspended),
        ],
    );
    if due_moved > 0 {
        app.metrics.increment(
            "workflow_due_claims",
            &[("outcome", "moved")],
            due_moved as f64,
        );
    }
    let do_alarm_counters = match dispatch_ready_do_alarms(app).await {
        Ok(result) => {
            if let Some(err) = result.error {
                log(
                    app,
                    LogLevel::Warn,
                    "do_alarm_tick_error",
                    fields_with_error(json!({ "error_code": err.code }), "Error", &err.message),
                );
            }
            result.counters
        }
        Err(err) => {
            log(
                app,
                LogLevel::Warn,
                "do_alarm_tick_error",
                fields_with_error(json!({ "error_code": err.code }), "Error", &err.message),
            );
            Default::default()
        }
    };
    Ok(TickResponse {
        dispatched: counters.dispatched,
        completed: counters.completed,
        failed: counters.failed,
        suspended: counters.suspended,
        due_moved,
        retention_cleaned,
        do_alarm_due_moved: do_alarm_counters.due_moved,
        do_alarm_dispatched: do_alarm_counters.dispatched,
        do_alarm_delivered: do_alarm_counters.delivered,
        do_alarm_retried: do_alarm_counters.retried,
        do_alarm_discarded: do_alarm_counters.discarded,
        do_alarm_skipped: do_alarm_counters.skipped,
    })
}

async fn apply_ready_token_result(
    app: &AppState,
    shard: usize,
    token: String,
    result: ReadyTokenResult,
    counters: &mut TickCounters,
) -> WorkflowResult<()> {
    match result {
        ReadyTokenResult::Completed => {
            counters.dispatched += 1;
            counters.completed += 1;
        }
        ReadyTokenResult::Failed => {
            counters.dispatched += 1;
            counters.failed += 1;
        }
        ReadyTokenResult::DispatchError => {
            counters.dispatched += 1;
        }
        ReadyTokenResult::Suspended => {
            counters.dispatched += 1;
            counters.suspended += 1;
        }
        ReadyTokenResult::SuspendedKeep => {
            counters.dispatched += 1;
            counters.suspended += 1;
        }
        ReadyTokenResult::RemoveMalformed => {
            remove_ready_token(app, shard, token).await?;
        }
        ReadyTokenResult::RemoveIfStateMissing(identity) => {
            remove_ready_token_if_state_missing(app, shard, token, identity).await?;
        }
        ReadyTokenResult::RemoveIfTerminal(guard) => {
            remove_ready_token_if_terminal(app, shard, token, guard).await?;
        }
        ReadyTokenResult::Keep => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_commit_removes_ready_token_inside_fenced_script() {
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"redis.call("SREM", KEYS[4], ARGV[7])"#));
    }

    #[test]
    fn terminal_commit_removes_due_token_inside_fenced_script() {
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"redis.call("ZREM", KEYS[5], ARGV[7])"#));
    }

    #[test]
    fn terminal_payload_cap_failure_is_terminal_not_retried() {
        assert!(
            COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#""errorCode", "workflow_payload_too_large""#)
        );
        assert!(
            COMMIT_RUNTIME_TERMINAL_SCRIPT
                .contains(r#"redis.call("HDEL", KEYS[1], "runToken", "runLeaseExpiresAtMs", "waitingEventIndexPrefix")"#)
        );
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains("return 2"));
    }

    #[test]
    fn terminal_commit_rejects_expired_run_claims() {
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#""runLeaseExpiresAtMs""#));
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"if lease <= tonumber(ARGV[10]) then"#));
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"if waiting_failed then"#));
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"redis.call("SADD", KEYS[4], ARGV[7])"#));
        assert!(
            COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"redis.call("SADD", KEYS[6], ARGV[11])"#)
        );
        assert!(COMMIT_RUNTIME_TERMINAL_SCRIPT.contains(r#"return 3"#));
    }

    #[test]
    fn ready_dispatch_uses_shared_runner_without_error_prune() {
        let source = include_str!("tick.rs");
        let implementation = source
            .split("\n#[cfg(test)]\nmod tests")
            .next()
            .expect("tick implementation should precede tests");

        assert!(implementation.contains("dispatch_ready_members("));
        assert!(implementation.contains("workflow_shard_queue_keys()"));
        assert!(implementation.contains("prune_on_error: false"));
    }

    #[test]
    fn running_ready_tokens_requeue_expired_claims_before_runtime_dispatch() {
        let source = include_str!("tick.rs");
        let running_branch = source
            .find(r#"if status == "running" {"#)
            .expect("ready-token dispatch must branch on running instances");
        let branch_source = &source[running_branch..];
        let requeue_pos = branch_source
            .find("requeue_expired_run_claim(app, &identity).await?")
            .expect("running instances must first try expired-claim requeue");
        let keep_pos = branch_source
            .find("return Ok(ReadyTokenResult::Keep);")
            .expect("running branch must stop before runtime dispatch");
        let claim_pos = branch_source
            .find("claim_run(app, &identity, &previous_status)")
            .expect("queued/waiting instances still claim after the running branch");
        let dispatch_pos = branch_source
            .find("dispatch_runtime(app, &identity, &claim.token")
            .expect("runtime dispatch must remain after claim_run");

        assert!(requeue_pos < keep_pos);
        assert!(keep_pos < claim_pos);
        assert!(claim_pos < dispatch_pos);
    }

    #[test]
    fn failed_terminal_commit_can_override_same_run_waiting_state() {
        assert!(
            COMMIT_RUNTIME_TERMINAL_SCRIPT
                .contains(r#"local waiting_failed = ARGV[3] == "failed" and status == "waiting""#)
        );
        assert!(
            COMMIT_RUNTIME_TERMINAL_SCRIPT
                .contains(r#"if status ~= "running" and not waiting_failed then"#)
        );
    }

    #[test]
    fn do_alarm_tick_errors_do_not_fail_workflow_tick_response() {
        let source = include_str!("tick.rs");
        assert!(source.contains("match dispatch_ready_do_alarms(app).await"));
        assert!(source.contains("\"do_alarm_tick_error\""));
        assert!(source.contains("Default::default()"));
    }
}
