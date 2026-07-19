use std::time::Duration;

use reqwest::StatusCode;
use serde_json::{Value as JsonValue, json};

use crate::{AppState, Config, SchedulerError, SchedulerResult, now_ms};
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

fn workflow_tick_request(
    client: &reqwest::Client,
    config: &Config,
    url: &str,
    request_id: &str,
) -> reqwest::RequestBuilder {
    client
        .post(url)
        .header("content-type", "application/json")
        .header(INTERNAL_AUTH_HEADER, config.internal_auth_token.as_str())
        .header("x-request-id", request_id)
        .timeout(Duration::from_millis(config.workflows_tick_timeout_ms))
        .json(&json!({}))
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
    let response = workflow_tick_request(&state.http, &state.config, &url, &request_id)
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

#[cfg(test)]
mod tests {
    use super::*;
    use wdl_rust_common::test_env::with_temp_envs;

    #[test]
    fn workflow_tick_request_uses_its_dedicated_timeout() {
        with_temp_envs(
            &[
                ("WDL_INTERNAL_AUTH_TOKEN", Some("test-internal-auth-token")),
                ("SCHEDULER_FIRE_TIMEOUT_MS", Some("60000")),
                ("WORKFLOWS_TICK_TIMEOUT_MS", Some("175000")),
            ],
            || {
                let config = crate::config_from_env();
                let request = workflow_tick_request(
                    &reqwest::Client::new(),
                    &config,
                    "http://127.0.0.1:9120/internal/workflows/tick",
                    "workflow-tick-test",
                )
                .build()
                .expect("workflow tick request should build");

                assert_eq!(
                    request.timeout().copied(),
                    Some(Duration::from_millis(175_000))
                );
            },
        );
    }
}
