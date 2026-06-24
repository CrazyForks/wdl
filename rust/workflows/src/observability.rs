use serde_json::{Value as JsonValue, json};
pub(crate) use wdl_rust_common::log::{LogLevel, emit_log_line};
pub(crate) use wdl_rust_common::log_fields::fields_with_error;

use crate::{AppState, SERVICE, WorkflowError};

pub(crate) type Metrics = wdl_rust_common::metrics::MetricStore;

pub(crate) fn log(state: &AppState, level: LogLevel, event: &str, fields: JsonValue) {
    emit_log_line(SERVICE, level, state.config.log_level, event, fields);
}

pub(crate) fn workflow_error_fields(err: &WorkflowError) -> JsonValue {
    fields_with_error(json!({ "error_code": err.code }), "Error", &err.message)
}
