use std::collections::HashMap;

use serde_json::Value as JsonValue;

use crate::{WorkflowError, WorkflowResult};

const DEFAULT_WORKFLOW_RETENTION_MS: i64 = 8 * 60 * 60 * 1000;
const MAX_WORKFLOW_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy)]
pub(super) struct RetentionPolicy {
    pub(super) success_ms: i64,
    pub(super) error_ms: i64,
}

fn default_retention_policy() -> RetentionPolicy {
    RetentionPolicy {
        success_ms: DEFAULT_WORKFLOW_RETENTION_MS,
        error_ms: DEFAULT_WORKFLOW_RETENTION_MS,
    }
}

fn duration_ms_from_json(value: &JsonValue, field: &str) -> WorkflowResult<i64> {
    let Some(ms) = duration_ms_opt(value, field)? else {
        return Err(WorkflowError::invalid_request(format!(
            "Workflow retention {field} must be a duration"
        )));
    };
    Ok(ms)
}

fn duration_ms_opt(value: &JsonValue, field: &str) -> WorkflowResult<Option<i64>> {
    if value.is_null() {
        return Ok(None);
    }
    let ms = if let Some(ms) = value.as_i64() {
        ms
    } else if let Some(raw) = value.as_str() {
        parse_duration_ms(raw).ok_or_else(|| {
            WorkflowError::invalid_request(format!("Workflow retention {field} must be a duration"))
        })?
    } else {
        return Err(WorkflowError::invalid_request(format!(
            "Workflow retention {field} must be a duration"
        )));
    };
    if !(0..=MAX_WORKFLOW_RETENTION_MS).contains(&ms) {
        return Err(WorkflowError::invalid_request(format!(
            "Workflow retention {field} must be in [0, {MAX_WORKFLOW_RETENTION_MS}] milliseconds"
        )));
    }
    Ok(Some(ms))
}

fn parse_duration_ms(raw: &str) -> Option<i64> {
    let text = raw.trim().to_ascii_lowercase();
    if text.is_empty() {
        return None;
    }
    let split_at = text.find(|ch: char| !ch.is_ascii_digit())?;
    let (number, unit) = text.split_at(split_at);
    let amount = number.parse::<i64>().ok()?;
    let unit = unit.trim();
    let factor = match unit {
        "ms" | "millisecond" | "milliseconds" => 1,
        "s" | "sec" | "secs" | "second" | "seconds" => 1000,
        "m" | "min" | "mins" | "minute" | "minutes" => 60 * 1000,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60 * 60 * 1000,
        "d" | "day" | "days" => 24 * 60 * 60 * 1000,
        _ => return None,
    };
    amount.checked_mul(factor)
}

pub(super) fn retention_policy(value: &JsonValue) -> WorkflowResult<RetentionPolicy> {
    if value.is_null() {
        return Ok(default_retention_policy());
    }
    let object = value
        .as_object()
        .ok_or_else(|| WorkflowError::invalid_request("Workflow retention must be an object"))?;
    let default = default_retention_policy();
    let success_ms = match object
        .get("successRetention")
        .or_else(|| object.get("successRetentionMs"))
    {
        Some(value) => duration_ms_from_json(value, "successRetention")?,
        None => default.success_ms,
    };
    let error_ms = match object
        .get("errorRetention")
        .or_else(|| object.get("errorRetentionMs"))
    {
        Some(value) => duration_ms_from_json(value, "errorRetention")?,
        None => default.error_ms,
    };
    Ok(RetentionPolicy {
        success_ms,
        error_ms,
    })
}

pub(crate) fn terminal_retention_ms(
    state: &HashMap<String, String>,
    outcome: &str,
) -> WorkflowResult<i64> {
    let field = if outcome == "completed" {
        "successRetentionMs"
    } else {
        "errorRetentionMs"
    };
    match state.get(field) {
        Some(raw) => raw.parse::<i64>().map_err(|err| {
            WorkflowError::invalid_state(format!("Workflow retention field is corrupt: {err}"))
        }),
        None => Ok(DEFAULT_WORKFLOW_RETENTION_MS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_retention_to_eight_hours() {
        let expected = 8 * 60 * 60 * 1000;
        let policy = retention_policy(&JsonValue::Null).expect("default retention should parse");
        assert_eq!(policy.success_ms, expected);
        assert_eq!(policy.error_ms, expected);
    }
}
