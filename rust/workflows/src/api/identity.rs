use std::collections::HashMap;

use serde_json::{Value as JsonValue, json};

use crate::{AppState, InstanceIdentity, LogLevel, WorkflowError, WorkflowResult, log};

use super::WorkflowRequest;

const WORKFLOW_INSTANCE_ID_MAX_BYTES: usize = 128;

pub(super) fn require_non_empty<'a>(value: &'a str, field: &str) -> WorkflowResult<&'a str> {
    if value.is_empty() {
        return Err(WorkflowError::invalid_request(format!(
            "{field} is required"
        )));
    }
    Ok(value)
}

pub(crate) fn validate_instance_id_value(value: &str) -> WorkflowResult<()> {
    if value.is_empty() {
        return Err(WorkflowError::invalid_request("instanceId is required"));
    }
    if value.len() > WORKFLOW_INSTANCE_ID_MAX_BYTES {
        return Err(WorkflowError::invalid_request(format!(
            "instanceId must be at most {WORKFLOW_INSTANCE_ID_MAX_BYTES} bytes"
        )));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(WorkflowError::invalid_request("instanceId is required"));
    };
    if !first.is_ascii_alphanumeric()
        || !chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err(WorkflowError::invalid_request(
            "instanceId must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
        ));
    }
    Ok(())
}

pub(super) fn validate_identity(req: &WorkflowRequest) -> WorkflowResult<()> {
    require_non_empty(&req.ns, "ns")?;
    require_non_empty(&req.worker, "worker")?;
    require_non_empty(&req.frozen_version, "frozenVersion")?;
    require_non_empty(&req.workflow_name, "workflowName")?;
    require_non_empty(&req.workflow_key, "workflowKey")?;
    require_non_empty(&req.class_name, "className")?;
    Ok(())
}

pub(super) fn instance_id(req: &WorkflowRequest) -> WorkflowResult<&str> {
    let id = req
        .instance_id
        .as_deref()
        .ok_or_else(|| WorkflowError::invalid_request("instanceId is required"))?;
    validate_instance_id_value(id)?;
    Ok(id)
}

pub(super) fn parse_positive_identity_i64(value: &str, field: &str) -> WorkflowResult<i64> {
    let parsed = value.parse::<i64>().map_err(|err| {
        WorkflowError::invalid_state(format!("Workflow {field} is corrupt: {err}"))
    })?;
    if parsed <= 0 {
        return Err(WorkflowError::invalid_state(format!(
            "Workflow {field} must be a positive integer"
        )));
    }
    Ok(parsed)
}

fn identity_fields_from_request(req: &WorkflowRequest, instance_id: &str) -> JsonValue {
    json!({
        "namespace": req.ns,
        "worker": req.worker,
        "workflow_name": req.workflow_name,
        "workflow_key": req.workflow_key,
        "workflow_class": req.class_name,
        "instance_id": instance_id,
        "frozen_version": req.frozen_version,
        "request_id": req.request_id,
    })
}

fn identity_fields(identity: &InstanceIdentity) -> JsonValue {
    json!({
        "namespace": identity.ns,
        "worker": identity.worker,
        "workflow_name": identity.workflow_name,
        "workflow_key": identity.workflow_key,
        "workflow_class": identity.class_name,
        "instance_id": identity.instance_id,
        "frozen_version": identity.frozen_version,
        "generation": identity.generation,
    })
}

pub(super) fn log_instance_event_from_request(
    state: &AppState,
    event: &str,
    req: &WorkflowRequest,
    instance_id: &str,
) {
    log(
        state,
        LogLevel::Info,
        event,
        identity_fields_from_request(req, instance_id),
    );
}

pub(super) fn log_instance_event(state: &AppState, event: &str, identity: &InstanceIdentity) {
    log(state, LogLevel::Info, event, identity_fields(identity));
}

pub(super) fn identity_from_state(
    ns: &str,
    workflow_key: &str,
    instance_id: &str,
    state: &HashMap<String, String>,
) -> WorkflowResult<InstanceIdentity> {
    let field = |name: &str| {
        state
            .get(name)
            .cloned()
            .ok_or_else(|| WorkflowError::invalid_state(format!("Workflow state missing {name}")))
    };
    let stored_ns = field("ns")?;
    let stored_workflow_key = field("workflowKey")?;
    let stored_instance_id = field("instanceId")?;
    if stored_ns != ns || stored_workflow_key != workflow_key || stored_instance_id != instance_id {
        return Err(WorkflowError::invalid_state(
            "Workflow ready token does not match instance state",
        ));
    }
    Ok(InstanceIdentity {
        ns: stored_ns,
        worker: field("worker")?,
        frozen_version: field("frozenVersion")?,
        workflow_name: field("workflowName")?,
        workflow_key: stored_workflow_key,
        class_name: field("className")?,
        instance_id: stored_instance_id,
        generation: field("generation")?,
        created_at_ms: field("createdAtMs")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity_cases(field: &str) -> Vec<(String, bool)> {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/cross-language-identity.json"
        ))
        .expect("identity fixture parses");
        fixture[field]
            .as_array()
            .expect("identity fixture field is an array")
            .iter()
            .map(|entry| {
                (
                    entry["value"]
                        .as_str()
                        .expect("identity fixture value is a string")
                        .to_string(),
                    entry["valid"]
                        .as_bool()
                        .expect("identity fixture valid is a boolean"),
                )
            })
            .collect()
    }

    #[test]
    fn workflow_instance_id_grammar_matches_cross_language_fixture() {
        for (value, valid) in identity_cases("workflowInstanceIds") {
            assert_eq!(
                validate_instance_id_value(&value).is_ok(),
                valid,
                "workflowInstanceIds:{value:?}"
            );
        }
    }

    #[test]
    fn workflow_instance_id_grammar_matches_public_contract() {
        for value in ["a", "A", "a-b", "A_B-9"] {
            validate_instance_id_value(value).expect("valid instance id");
        }
        for value in ["", "_leading", "-leading", "bad/slash", "bad\tid"] {
            assert!(validate_instance_id_value(value).is_err());
        }
        assert!(validate_instance_id_value(&"a".repeat(128)).is_ok());
        assert!(validate_instance_id_value(&"a".repeat(129)).is_err());
    }

    #[test]
    fn positive_identity_i64_parser_rejects_corrupt_values() {
        assert_eq!(parse_positive_identity_i64("1", "generation").unwrap(), 1);
        assert_eq!(parse_positive_identity_i64("12", "generation").unwrap(), 12);
        assert!(parse_positive_identity_i64("0", "generation").is_err());
        assert!(parse_positive_identity_i64("-1", "generation").is_err());
        assert!(parse_positive_identity_i64("1.5", "generation").is_err());
        assert!(parse_positive_identity_i64("not-a-number", "generation").is_err());
    }
}
