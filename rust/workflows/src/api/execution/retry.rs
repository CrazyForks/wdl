use serde_json::Value as JsonValue;

use crate::{WorkflowError, WorkflowResult};

const DEFAULT_STEP_RETRY_LIMIT: u32 = 1;
const MAX_STEP_RETRY_LIMIT: u32 = 100;
const DEFAULT_STEP_RETRY_DELAY_MS: i64 = 10_000;
const MAX_STEP_RETRY_DELAY_MS: i64 = 3_600_000;

#[derive(Debug)]
pub(crate) struct StepRetryPolicy {
    pub(crate) limit: u32,
    pub(crate) delay_ms: i64,
    pub(crate) backoff: String,
}

pub(crate) fn retry_policy(config: &JsonValue) -> WorkflowResult<StepRetryPolicy> {
    let retries = config.get("retries");
    let Some(retries) = retries else {
        return Ok(StepRetryPolicy {
            limit: DEFAULT_STEP_RETRY_LIMIT,
            delay_ms: DEFAULT_STEP_RETRY_DELAY_MS,
            backoff: "exponential".to_string(),
        });
    };
    if !retries.is_object() {
        return Err(WorkflowError::invalid_request(
            "workflow step retries config must be an object",
        ));
    }
    let limit = match retries.get("limit") {
        Some(raw) => {
            let Some(limit) = raw.as_u64() else {
                return Err(WorkflowError::invalid_request(
                    "workflow step retry limit must be an integer",
                ));
            };
            u32::try_from(limit).map_err(|_| {
                WorkflowError::request_too_large("workflow step retry limit is too large")
            })?
        }
        None => DEFAULT_STEP_RETRY_LIMIT,
    };
    if !(1..=MAX_STEP_RETRY_LIMIT).contains(&limit) {
        return Err(WorkflowError::request_too_large(format!(
            "workflow step retry limit must be in [1, {MAX_STEP_RETRY_LIMIT}]"
        )));
    }
    let delay_ms = match retries.get("delayMs").or_else(|| retries.get("delay")) {
        Some(raw) => raw.as_i64().ok_or_else(|| {
            WorkflowError::invalid_request("workflow step retry delayMs must be an integer")
        })?,
        None => DEFAULT_STEP_RETRY_DELAY_MS,
    };
    if !(0..=MAX_STEP_RETRY_DELAY_MS).contains(&delay_ms) {
        return Err(WorkflowError::request_too_large(format!(
            "workflow step retry delayMs must be in [0, {MAX_STEP_RETRY_DELAY_MS}]"
        )));
    }
    let backoff = retries
        .get("backoff")
        .and_then(JsonValue::as_str)
        .unwrap_or("exponential");
    if !matches!(backoff, "constant" | "linear" | "exponential") {
        return Err(WorkflowError::invalid_request(
            "workflow step retry backoff must be constant, linear, or exponential",
        ));
    }
    Ok(StepRetryPolicy {
        limit,
        delay_ms,
        backoff: backoff.to_string(),
    })
}

pub(crate) fn retry_due_at_ms(now: i64, policy: &StepRetryPolicy, attempt: u32) -> i64 {
    let multiplier = match policy.backoff.as_str() {
        "constant" => 1_i64,
        "linear" => i64::from(attempt),
        "exponential" => {
            let exponent = attempt.saturating_sub(1).min(20);
            1_i64 << exponent
        }
        _ => 1_i64,
    };
    let delay = policy.delay_ms.saturating_mul(multiplier);
    now.saturating_add(delay)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_policy_uses_default_policy_without_config() {
        let policy = retry_policy(&json!({})).expect("default retry policy");

        assert_eq!(policy.limit, 1);
        assert_eq!(policy.delay_ms, 10_000);
        assert_eq!(policy.backoff, "exponential");
        assert_eq!(retry_due_at_ms(1_000, &policy, 1), 11_000);
    }

    #[test]
    fn retry_policy_accepts_delay_alias_under_retries_config() {
        let policy = retry_policy(&json!({
            "retries": { "limit": 4, "delay": 250, "backoff": "constant" }
        }))
        .expect("delay alias should be accepted");

        assert_eq!(policy.limit, 4);
        assert_eq!(policy.delay_ms, 250);
        assert_eq!(policy.backoff, "constant");
        assert_eq!(retry_due_at_ms(2_000, &policy, 3), 2_250);
    }

    #[test]
    fn retry_policy_rejects_out_of_range_and_unknown_backoff() {
        for config in [
            json!({ "retries": { "limit": 0 } }),
            json!({ "retries": { "limit": 101 } }),
            json!({ "retries": { "delayMs": -1 } }),
            json!({ "retries": { "delayMs": 3_600_001 } }),
            json!({ "retries": { "backoff": "jitter" } }),
        ] {
            assert!(
                retry_policy(&config).is_err(),
                "config should be rejected: {config}"
            );
        }
    }

    #[test]
    fn retry_due_at_ms_saturates_exponential_growth_and_timestamp_addition() {
        let policy = StepRetryPolicy {
            limit: 100,
            delay_ms: 2,
            backoff: "exponential".to_string(),
        };

        assert_eq!(retry_due_at_ms(100, &policy, 1), 102);
        assert_eq!(retry_due_at_ms(100, &policy, 30), 100 + (2 * (1_i64 << 20)));

        let overflowing = StepRetryPolicy {
            limit: 100,
            delay_ms: i64::MAX,
            backoff: "linear".to_string(),
        };
        assert_eq!(retry_due_at_ms(i64::MAX - 1, &overflowing, 2), i64::MAX);
    }
}
