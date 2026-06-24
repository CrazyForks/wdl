use std::sync::OnceLock;

use wdl_rust_common::log::{LogLevel as Level, emit_log_line, log_level_from_env};

fn current_level() -> Level {
    static LEVEL: OnceLock<Level> = OnceLock::new();
    *LEVEL.get_or_init(log_level_from_env)
}

pub(crate) fn log(level: Level, service: &str, event: &str, fields: serde_json::Value) {
    emit_log_line(service, level, current_level(), event, fields);
}

pub(crate) fn info(service: &str, event: &str, fields: serde_json::Value) {
    log(Level::Info, service, event, fields);
}

pub(crate) fn warn(service: &str, event: &str, fields: serde_json::Value) {
    log(Level::Warn, service, event, fields);
}

pub(crate) fn error(service: &str, event: &str, fields: serde_json::Value) {
    log(Level::Error, service, event, fields);
}

pub(crate) fn reqwest_error_fields(err: &reqwest::Error) -> serde_json::Value {
    let code = if err.is_timeout() {
        "timeout"
    } else if err.is_connect() {
        "connect_failed"
    } else if err.is_body() {
        "body_read_failed"
    } else if err.is_decode() {
        "decode_failed"
    } else if err.is_request() {
        "request_failed"
    } else {
        "transport_error"
    };
    serde_json::json!({
        "error_code": code,
        "error_message": err.to_string(),
    })
}
