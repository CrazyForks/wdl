use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{Value as JsonValue, json};

use crate::{AppState, SchedulerError, SchedulerResult, now_ms};
use wdl_rust_common::internal_auth::INTERNAL_AUTH_HEADER;

pub(crate) struct RemoteTickResponse {
    pub(crate) request_id: String,
    pub(crate) started_at_ms: i64,
    pub(crate) status: StatusCode,
    pub(crate) text: String,
    pub(crate) body: JsonValue,
}

pub(crate) fn json_usize(value: Option<&JsonValue>) -> usize {
    value.and_then(JsonValue::as_u64).unwrap_or(0) as usize
}

pub(crate) async fn post_remote_tick(
    state: &AppState,
    host: &str,
    port: u16,
    path: &str,
    request_id_prefix: &str,
    failure_message: &str,
) -> SchedulerResult<RemoteTickResponse> {
    let url = format!("http://{host}:{port}{path}");
    let request_id = format!("{request_id_prefix}-{}-{}", state.instance_id, now_ms());
    let started_at_ms = now_ms();
    let response = state
        .http
        .post(url)
        .header("content-type", "application/json")
        .header(
            INTERNAL_AUTH_HEADER,
            state.config.internal_auth_token.as_str(),
        )
        .header("x-request-id", &request_id)
        .timeout(Duration::from_millis(state.config.fire_timeout_ms))
        .json(&json!({}))
        .send()
        .await
        .map_err(|err| SchedulerError::internal_error(format!("{failure_message}: {err}")))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let body = serde_json::from_str::<JsonValue>(&text).unwrap_or_else(|_| json!({}));
    Ok(RemoteTickResponse {
        request_id,
        started_at_ms,
        status,
        text,
        body,
    })
}
