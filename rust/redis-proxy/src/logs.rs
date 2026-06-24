use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

use crate::{AppError, AppResult, AppState, empty};

// Stream cap is part of the log-tail wire contract. The approximate trim (~)
// means Redis allows the stream to grow modestly past 500 between
// listpack-aligned trims; tail UX tolerates that.
pub(crate) const TAIL_STREAM_MAXLEN: i64 = 500;

// Write-driven TTL (10 min). Refreshed on every XADD so an idle tailed
// worker — or one with no live tailers — lets the key expire ~10 min
// after the last write. control never sets/clears TTL.
pub(crate) const TAIL_STREAM_PEXPIRE_MS: u64 = 600_000;

pub(crate) const TAIL_EVENT_MAX_BYTES: usize = 5 * 1024;
pub(crate) const TAIL_ACTIVATION_KEY: &str = "logs:tail:active";

// `<ns>:<worker>`: exactly one ':' separator, both halves non-empty,
// neither half itself contains ':' (already implied by exactly-one).
pub(crate) fn is_valid_activation_key(payload: &str) -> bool {
    let mut parts = payload.split(':');
    let Some(ns) = parts.next() else {
        return false;
    };
    let Some(worker) = parts.next() else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    !ns.is_empty() && !worker.is_empty()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LogsTailAppendBody {
    ns: String,
    worker: String,
    // Pre-serialized event JSON. tail-worker stringifies before sending so
    // the proxy doesn't need a typed schema; new event-type fields land
    // in `json` without changing this endpoint.
    json: String,
}

fn validate_segment(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() {
        return Err(AppError::bad_request(format!("{label} must be non-empty")));
    }
    // Activation key uses ":" as separator, so the segment itself cannot
    // contain ":". Bundle-key grammar at control ingress already rejects
    // these for tenant ns / worker, but the proxy is the boundary that
    // hands the key to Redis — keep the check here too.
    if value.contains(':') {
        return Err(AppError::bad_request(format!(
            "{label} must not contain ':'"
        )));
    }
    Ok(())
}

pub(crate) fn validate_tail_event_json(json: &str) -> AppResult<()> {
    if json.len() > TAIL_EVENT_MAX_BYTES {
        return Err(AppError::bad_request(format!(
            "tail event exceeds {TAIL_EVENT_MAX_BYTES} byte limit"
        )));
    }
    Ok(())
}

pub(crate) fn tail_stream_key(ns: &str, worker: &str) -> String {
    format!("logs:{ns}:{worker}:s")
}

pub(crate) fn activation_key(ns: &str, worker: &str) -> String {
    format!("{ns}:{worker}")
}

async fn active_tail_keys(state: &AppState) -> Result<Vec<String>, redis::RedisError> {
    state
        .with_redis(async |mut conn| {
            redis::cmd("HKEYS")
                .arg(TAIL_ACTIVATION_KEY)
                .query_async(&mut conn)
                .await
        })
        .await
}

async fn tail_key_is_active(state: &AppState, key: String) -> Result<bool, redis::RedisError> {
    state
        .with_redis(async |mut conn| {
            redis::cmd("HEXISTS")
                .arg(TAIL_ACTIVATION_KEY)
                .arg(key)
                .query_async(&mut conn)
                .await
        })
        .await
}

// Used by tail-worker to gate `console.*` forwarding. Returning the
// full active set (not a per-key probe) lets tail-worker cache the
// answer for a few seconds and decide synchronously per event without
// a fetch hop, which is the difference between O(events) loopback HTTP
// when nobody's tailing and O(seconds) — the design's "near-zero idle
// cost when no one is watching" property.
pub(crate) async fn logs_tail_active(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let active: Vec<String> = active_tail_keys(&state)
        .await?
        .into_iter()
        .filter(|key| is_valid_activation_key(key))
        .collect();
    Ok(Json(json!({ "active": active })))
}

pub(crate) async fn logs_tail_append(
    State(state): State<AppState>,
    Json(body): Json<LogsTailAppendBody>,
) -> AppResult<Response> {
    validate_segment(&body.ns, "ns")?;
    validate_segment(&body.worker, "worker")?;
    validate_tail_event_json(&body.json)?;
    let key = activation_key(&body.ns, &body.worker);
    if !tail_key_is_active(&state, key).await? {
        // Designed-in fast path: tail-worker only calls this endpoint after
        // its active-set cache says someone is watching, and Valkey HFE
        // rejects stale activation if that cache races expiry.
        return Ok(empty(StatusCode::NO_CONTENT));
    }
    let stream_key = tail_stream_key(&body.ns, &body.worker);
    let mut pipe = redis::Pipeline::new();
    pipe.atomic();
    pipe.cmd("XADD")
        .arg(&stream_key)
        .arg("MAXLEN")
        .arg("~")
        .arg(TAIL_STREAM_MAXLEN)
        .arg("*")
        .arg("json")
        .arg(&body.json);
    pipe.cmd("PEXPIRE")
        .arg(&stream_key)
        .arg(TAIL_STREAM_PEXPIRE_MS);
    let _: redis::Value = state
        .with_redis(async |mut conn| pipe.query_async(&mut conn).await)
        .await?;
    Ok(empty(StatusCode::NO_CONTENT))
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;

    use super::*;

    #[test]
    fn tail_activation_payload_validation_rejects_arbitrary_strings() {
        assert!(is_valid_activation_key("demo:hello"));
        assert!(is_valid_activation_key("__system__:s3-cleanup"));
        assert!(is_valid_activation_key("a:b"));

        assert!(!is_valid_activation_key(""));
        assert!(!is_valid_activation_key(":"));
        assert!(!is_valid_activation_key("a:"));
        assert!(!is_valid_activation_key(":b"));

        assert!(!is_valid_activation_key("only"));
        assert!(!is_valid_activation_key("a:b:c"));
        assert!(!is_valid_activation_key("a:b:"));

        assert!(is_valid_activation_key("Demo:Hello-1"));
    }

    #[test]
    fn tail_keys_match_docs_log_tail_layout() {
        assert_eq!(tail_stream_key("demo", "hello"), "logs:demo:hello:s");
        assert_eq!(activation_key("demo", "hello"), "demo:hello");
        assert_eq!(TAIL_ACTIVATION_KEY, "logs:tail:active");
        assert_eq!(TAIL_EVENT_MAX_BYTES, 5 * 1024);
        assert_eq!(TAIL_STREAM_MAXLEN, 500);
        assert_eq!(TAIL_STREAM_PEXPIRE_MS, 600_000);
    }

    #[test]
    fn tail_event_json_size_limit_rejects_oversized_entries() {
        validate_tail_event_json(&"x".repeat(TAIL_EVENT_MAX_BYTES)).unwrap();

        let err = validate_tail_event_json(&"x".repeat(TAIL_EVENT_MAX_BYTES + 1)).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert!(err.message.contains("tail event exceeds"));
    }
}
