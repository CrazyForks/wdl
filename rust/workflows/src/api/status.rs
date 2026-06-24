use std::collections::HashMap;

use serde_json::{Value as JsonValue, json};

use crate::{AppState, WorkflowError, WorkflowResult, by_workflow_key, instance_state_key};

use super::{
    InstanceResponse, ListInstancesResponse, WorkflowRequest, instance_id, public_state_or_empty,
    read_payload_ref, read_step_history, validate_identity, verify_workflow_def,
    workflow_step_options,
};

const DEFAULT_INSTANCES_LIMIT: usize = 100;
const MAX_INSTANCES_LIMIT: usize = 1000;

fn workflow_instances_options(options: &JsonValue) -> WorkflowResult<(usize, u64)> {
    let limit = match options.get("limit") {
        Some(raw) => {
            let Some(value) = raw.as_u64() else {
                return Err(WorkflowError::invalid_request(
                    "instances limit must be an integer",
                ));
            };
            let Ok(value) = usize::try_from(value) else {
                return Err(WorkflowError::request_too_large(
                    "instances limit exceeds the 1000 item limit",
                ));
            };
            if !(1..=MAX_INSTANCES_LIMIT).contains(&value) {
                return Err(WorkflowError::request_too_large(
                    "instances limit must be in [1, 1000]",
                ));
            }
            value
        }
        None => DEFAULT_INSTANCES_LIMIT,
    };
    let cursor = match options.get("cursor") {
        Some(raw) => {
            let Some(raw) = raw.as_str() else {
                return Err(WorkflowError::invalid_request(
                    "instances cursor must be a string",
                ));
            };
            if raw.is_empty() {
                0
            } else {
                raw.parse::<u64>()
                    .map_err(|_| WorkflowError::invalid_request("instances cursor is invalid"))?
            }
        }
        None => 0,
    };
    Ok((limit, cursor))
}

fn inline_error_from_state(state: &HashMap<String, String>) -> Option<JsonValue> {
    let code = state.get("errorCode")?;
    let message = state
        .get("errorMessage")
        .cloned()
        .unwrap_or_else(|| code.clone());
    Some(json!({ "name": "WorkflowError", "code": code, "message": message }))
}

pub(super) async fn read_state(
    state: &AppState,
    req: &WorkflowRequest,
) -> WorkflowResult<HashMap<String, String>> {
    let id = instance_id(req)?.to_string();
    read_state_by_id(state, &req.ns, &req.workflow_key, &id).await
}

pub(super) async fn read_state_by_id(
    state: &AppState,
    ns: &str,
    workflow_key: &str,
    instance_id: &str,
) -> WorkflowResult<HashMap<String, String>> {
    let key = instance_state_key(ns, workflow_key, instance_id);
    state
        .redis
        .with_conn(async |mut conn| redis::cmd("HGETALL").arg(key).query_async(&mut conn).await)
        .await
        .map_err(WorkflowError::from)
}

pub(super) async fn response_from_state(
    app: &AppState,
    id: &str,
    state: &HashMap<String, String>,
) -> WorkflowResult<InstanceResponse> {
    let status = state
        .get("status")
        .ok_or_else(|| WorkflowError::not_found("Workflow instance not found"))?;
    let output = read_payload_ref(app, state, "outputRef").await?;
    let error = match read_payload_ref(app, state, "errorRef").await? {
        Some(error) => Some(error),
        None => inline_error_from_state(state),
    };
    Ok(InstanceResponse {
        id: id.to_string(),
        status: status.to_string(),
        output,
        error,
        steps: None,
    })
}

async fn response_with_steps(
    app: &AppState,
    id: &str,
    state: &HashMap<String, String>,
    limit: usize,
) -> WorkflowResult<InstanceResponse> {
    let mut response = response_from_state(app, id, state).await?;
    let ns = state
        .get("ns")
        .ok_or_else(|| WorkflowError::invalid_state("Workflow state missing ns"))?;
    let workflow_key = state
        .get("workflowKey")
        .ok_or_else(|| WorkflowError::invalid_state("Workflow state missing workflowKey"))?;
    response.steps = Some(read_step_history(app, ns, workflow_key, id, limit).await?);
    Ok(response)
}

pub(super) async fn read_public_state(
    state: &AppState,
    req: &WorkflowRequest,
) -> WorkflowResult<HashMap<String, String>> {
    public_state_or_empty(state, read_state(state, req).await?).await
}

pub(super) async fn read_public_state_by_id(
    state: &AppState,
    ns: &str,
    workflow_key: &str,
    instance_id: &str,
) -> WorkflowResult<HashMap<String, String>> {
    public_state_or_empty(
        state,
        read_state_by_id(state, ns, workflow_key, instance_id).await?,
    )
    .await
}

pub(crate) async fn get_instance(
    state: &AppState,
    req: WorkflowRequest,
) -> WorkflowResult<InstanceResponse> {
    validate_identity(&req)?;
    let id = instance_id(&req)?.to_string();
    let existing = read_public_state(state, &req).await?;
    if existing.is_empty() {
        return Err(WorkflowError::not_found("Workflow instance not found"));
    }
    response_from_state(state, &id, &existing).await
}

pub(crate) async fn status_instance(
    state: &AppState,
    req: WorkflowRequest,
) -> WorkflowResult<InstanceResponse> {
    let step_limit = workflow_step_options(&req.options)?;
    validate_identity(&req)?;
    let id = instance_id(&req)?.to_string();
    let existing = read_public_state(state, &req).await?;
    if existing.is_empty() {
        return Err(WorkflowError::not_found("Workflow instance not found"));
    }
    match step_limit {
        Some(limit) => response_with_steps(state, &id, &existing, limit).await,
        None => response_from_state(state, &id, &existing).await,
    }
}

pub(crate) async fn list_instances(
    state: &AppState,
    req: WorkflowRequest,
) -> WorkflowResult<ListInstancesResponse> {
    let (limit, cursor) = workflow_instances_options(&req.options)?;
    validate_identity(&req)?;
    verify_workflow_def(state, &req).await?;
    let by_workflow = by_workflow_key(&req.ns, &req.worker, &req.workflow_key);
    let start = i64::try_from(cursor)
        .map_err(|_| WorkflowError::invalid_request("instances cursor is invalid"))?;
    let limit_u64 = u64::try_from(limit).unwrap_or(u64::MAX);
    let max_cursor = u64::try_from(i64::MAX).unwrap_or(u64::MAX);
    let stop = cursor.saturating_add(limit_u64).min(max_cursor);
    let stop = i64::try_from(stop)
        .map_err(|_| WorkflowError::invalid_request("instances cursor is invalid"))?;
    let mut members: Vec<String> = state
        .redis
        .with_conn(async |mut conn| {
            redis::cmd("ZRANGE")
                .arg(by_workflow)
                .arg(start)
                .arg(stop)
                .query_async(&mut conn)
                .await
        })
        .await?;
    let has_more = members.len() > limit;
    members.truncate(limit);
    let raw_states: Vec<HashMap<String, String>> = if members.is_empty() {
        Vec::new()
    } else {
        let state_keys = members
            .iter()
            .map(|instance_id| instance_state_key(&req.ns, &req.workflow_key, instance_id))
            .collect::<Vec<_>>();
        state
            .redis
            .with_conn(async |mut conn| {
                let mut pipe = redis::pipe();
                for key in &state_keys {
                    pipe.cmd("HGETALL").arg(key);
                }
                pipe.query_async(&mut conn).await
            })
            .await?
    };
    let mut instances = Vec::new();
    for (instance_id, raw_state) in members.iter().zip(raw_states) {
        let existing = public_state_or_empty(state, raw_state).await?;
        if existing.is_empty() {
            continue;
        }
        instances.push(response_from_state(state, instance_id, &existing).await?);
    }
    let next = cursor.saturating_add(u64::try_from(members.len()).unwrap_or(u64::MAX));

    Ok(ListInstancesResponse {
        instances,
        cursor: has_more.then(|| next.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_instances_uses_bounded_workflow_index_page() {
        let source = include_str!("status.rs");
        assert!(source.contains(r#"redis::cmd("ZRANGE")"#));
        assert!(!source.contains(concat!("SM", "EMBERS")));
        assert!(source.contains("members.truncate(limit)"));
    }

    #[test]
    fn inline_error_from_state_uses_stored_code_and_message() {
        let mut state = HashMap::new();
        state.insert(
            "errorCode".to_string(),
            "workflow_payload_too_large".to_string(),
        );
        state.insert(
            "errorMessage".to_string(),
            "payload budget exceeded".to_string(),
        );

        assert_eq!(
            inline_error_from_state(&state),
            Some(json!({
                "name": "WorkflowError",
                "code": "workflow_payload_too_large",
                "message": "payload budget exceeded",
            }))
        );
    }
}
