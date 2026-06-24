use serde_json::{Value as JsonValue, json};
pub(crate) use wdl_rust_common::log::{LogLevel, emit_log_line};
pub(crate) use wdl_rust_common::log_fields::fields_with_error;

use crate::{AppState, SERVICE, SchedulerError};

pub(crate) type Metrics = wdl_rust_common::metrics::MetricStore;

pub(crate) fn log(state: &AppState, level: LogLevel, event: &str, fields: JsonValue) {
    emit_log_line(SERVICE, level, state.config.log_level, event, fields);
}

pub(crate) fn error_fields(error_name: &str, error_message: impl Into<String>) -> JsonValue {
    json!({
        "error_name": error_name,
        "error_message": error_message.into(),
    })
}

pub(crate) fn scheduler_error_fields(err: &SchedulerError) -> JsonValue {
    fields_with_error(json!({ "error_code": err.code }), "Error", &err.message)
}

pub(crate) fn scheduler_fields_with_error(fields: JsonValue, err: &SchedulerError) -> JsonValue {
    let mut fields = match fields {
        JsonValue::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    fields.insert(
        "error_code".to_string(),
        JsonValue::String(err.code.to_string()),
    );
    fields_with_error(JsonValue::Object(fields), "Error", &err.message)
}

pub(crate) fn redis_fields_with_error(fields: JsonValue, err: &redis::RedisError) -> JsonValue {
    fields_with_error(fields, "RedisError", err.to_string())
}

pub(crate) fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "task panicked".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheduler_error_fields_use_stable_error_code() {
        let err = SchedulerError::internal_error("bad schedule");
        assert_eq!(
            scheduler_error_fields(&err),
            json!({
                "error_code": "internal_error",
                "error_name": "Error",
                "error_message": "bad schedule",
            })
        );
    }
}
