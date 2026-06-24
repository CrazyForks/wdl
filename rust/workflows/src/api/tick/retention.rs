use wdl_rust_common::time::now_ms;

use crate::{
    AppState, InstanceIdentity, WorkflowResult, by_version_key, by_worker_key, by_workflow_key,
    retention_key,
};

use super::super::{
    InstanceRouteKeys, eval_script, identity_from_state, parse_ready_token, read_state_by_id,
    workflow_referrer_member,
};

const RETENTION_BATCH_SIZE: usize = 100;

enum RetentionTokenState {
    RemoveToken,
    Wait,
    Cleanup(Box<InstanceIdentity>),
}

pub(super) const CLEANUP_RETENTION_SCRIPT: &str = r#"
local generation = redis.call("HGET", KEYS[1], "generation")
local status = redis.call("HGET", KEYS[1], "status")
if generation ~= ARGV[1] then
  return 0
end
if status ~= "completed" and status ~= "failed" and status ~= "terminated" then
  return 0
end
local expires_at = tonumber(redis.call("HGET", KEYS[1], "retentionExpiresAtMs") or "")
if not expires_at or expires_at > tonumber(ARGV[4]) then
  return 0
end
redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[11])
redis.call("SREM", KEYS[7], ARGV[2])
redis.call("SREM", KEYS[8], ARGV[2])
redis.call("ZREM", KEYS[9], ARGV[3])
redis.call("ZREM", KEYS[10], ARGV[5])
return 1
"#;

pub(super) async fn cleanup_retention(app: &AppState) -> WorkflowResult<usize> {
    let now = now_ms();
    let key = retention_key().to_string();
    let tokens: Vec<String> = app
        .redis
        .with_conn(async |mut conn| {
            redis::cmd("ZRANGEBYSCORE")
                .arg(&key)
                .arg("-inf")
                .arg(now)
                .arg("LIMIT")
                .arg(0)
                .arg(RETENTION_BATCH_SIZE)
                .query_async(&mut conn)
                .await
        })
        .await?;
    let mut cleaned = 0;
    for token in tokens {
        if cleanup_retention_token(app, &token, now).await? {
            cleaned += 1;
        }
    }
    if cleaned > 0 {
        app.metrics.increment(
            "workflow_retention_cleaned",
            &[("outcome", "cleaned")],
            cleaned as f64,
        );
    }
    Ok(cleaned)
}

async fn cleanup_retention_token(app: &AppState, token: &str, now: i64) -> WorkflowResult<bool> {
    let retention = retention_key().to_string();
    let Some((ns, workflow_key, instance_id)) = parse_ready_token(token) else {
        remove_retention_token(app, &retention, token).await?;
        return Ok(false);
    };
    let state = read_state_by_id(app, &ns, &workflow_key, &instance_id).await?;
    let identity = match retention_token_state(&ns, &workflow_key, &instance_id, &state, now) {
        RetentionTokenState::RemoveToken => {
            remove_retention_token(app, &retention, token).await?;
            return Ok(false);
        }
        RetentionTokenState::Wait => return Ok(false),
        RetentionTokenState::Cleanup(identity) => *identity,
    };
    let keys = InstanceRouteKeys::new(&identity.ns, &identity.workflow_key, &identity.instance_id);
    let state_key = keys.state();
    let payloads_key = keys.payloads();
    let steps_key = keys.steps();
    let summaries_key = keys.step_summaries();
    let summary_index_key = keys.step_summary_index();
    let events_key = keys.events();
    let event_index_key = keys.event_type_index();
    let by_worker = by_worker_key(&identity.ns, &identity.worker);
    let by_version = by_version_key(&identity.ns, &identity.worker, &identity.frozen_version);
    let by_workflow = by_workflow_key(&identity.ns, &identity.worker, &identity.workflow_key);
    // by-worker/by-version sets span workflows and store workflow referrers;
    // by-workflow is already workflow-scoped and stores bare instance ids.
    let referrer = workflow_referrer_member(&identity.workflow_key, &identity.instance_id);
    let member = token.to_string();
    let now_arg = now.to_string();
    let cleaned: i64 = eval_script(
        app,
        CLEANUP_RETENTION_SCRIPT,
        &[
            &state_key,
            &payloads_key,
            &steps_key,
            &summaries_key,
            &summary_index_key,
            &events_key,
            &by_worker,
            &by_version,
            &retention,
            &by_workflow,
            &event_index_key,
        ],
        &[
            &identity.generation,
            &referrer,
            &member,
            &now_arg,
            &identity.instance_id,
        ],
    )
    .await?;
    Ok(cleaned == 1)
}

fn retention_token_state(
    ns: &str,
    workflow_key: &str,
    instance_id: &str,
    state: &std::collections::HashMap<String, String>,
    now: i64,
) -> RetentionTokenState {
    if state.is_empty() {
        return RetentionTokenState::RemoveToken;
    }
    let status = state.get("status").map(String::as_str);
    if !matches!(status, Some("completed" | "failed" | "terminated")) {
        return RetentionTokenState::RemoveToken;
    }
    let expires_at = state
        .get("retentionExpiresAtMs")
        .and_then(|raw| raw.parse::<i64>().ok())
        .unwrap_or(now);
    if expires_at > now {
        return RetentionTokenState::Wait;
    }
    match identity_from_state(ns, workflow_key, instance_id, state) {
        Ok(identity) => RetentionTokenState::Cleanup(Box::new(identity)),
        Err(_) => RetentionTokenState::RemoveToken,
    }
}

async fn remove_retention_token(app: &AppState, key: &str, token: &str) -> WorkflowResult<()> {
    let key = key.to_string();
    let token = token.to_string();
    app.redis
        .with_conn(async |mut conn| {
            redis::cmd("ZREM")
                .arg(key)
                .arg(token)
                .query_async::<()>(&mut conn)
                .await
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_cleanup_is_generation_and_expiry_guarded() {
        assert!(CLEANUP_RETENTION_SCRIPT.contains("generation ~= ARGV[1]"));
        assert!(CLEANUP_RETENTION_SCRIPT.contains(r#"status ~= "completed""#));
        assert!(CLEANUP_RETENTION_SCRIPT.contains(r#"status ~= "failed""#));
        assert!(CLEANUP_RETENTION_SCRIPT.contains(r#"status ~= "terminated""#));
        assert!(CLEANUP_RETENTION_SCRIPT.contains("expires_at > tonumber(ARGV[4])"));
        assert!(CLEANUP_RETENTION_SCRIPT.contains(
            r#"redis.call("DEL", KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[11])"#
        ));
        assert!(CLEANUP_RETENTION_SCRIPT.contains(r#"redis.call("ZREM", KEYS[10], ARGV[5])"#));
    }

    fn retention_state() -> std::collections::HashMap<String, String> {
        std::collections::HashMap::from([
            ("ns".to_string(), "demo".to_string()),
            ("worker".to_string(), "shop".to_string()),
            ("frozenVersion".to_string(), "v1".to_string()),
            ("workflowName".to_string(), "orders".to_string()),
            ("workflowKey".to_string(), "wf_abc".to_string()),
            ("className".to_string(), "OrderWorkflow".to_string()),
            ("instanceId".to_string(), "inst-1".to_string()),
            ("generation".to_string(), "1".to_string()),
            ("createdAtMs".to_string(), "10".to_string()),
            ("status".to_string(), "completed".to_string()),
            ("retentionExpiresAtMs".to_string(), "100".to_string()),
        ])
    }

    #[test]
    fn corrupt_terminal_retention_state_removes_only_retention_token() {
        let mut state = retention_state();
        state.insert("workflowKey".to_string(), "wf_other".to_string());

        assert!(matches!(
            retention_token_state("demo", "wf_abc", "inst-1", &state, 100),
            RetentionTokenState::RemoveToken
        ));
    }

    #[test]
    fn future_terminal_retention_token_waits_until_expiry() {
        let state = retention_state();

        assert!(matches!(
            retention_token_state("demo", "wf_abc", "inst-1", &state, 99),
            RetentionTokenState::Wait
        ));
    }

    #[test]
    fn expired_terminal_retention_token_builds_cleanup_identity() {
        let state = retention_state();
        let RetentionTokenState::Cleanup(identity) =
            retention_token_state("demo", "wf_abc", "inst-1", &state, 100)
        else {
            panic!("expected cleanup identity");
        };
        assert_eq!(identity.ns, "demo");
        assert_eq!(identity.workflow_key, "wf_abc");
        assert_eq!(identity.instance_id, "inst-1");
    }
}
