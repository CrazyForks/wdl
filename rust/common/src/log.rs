use chrono::{SecondsFormat, Utc};
use serde_json::Value as JsonValue;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum LogLevel {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
}

impl LogLevel {
    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

pub fn log_level_from_env() -> LogLevel {
    std::env::var("LOG_LEVEL")
        .ok()
        .as_deref()
        .and_then(LogLevel::parse)
        .unwrap_or(LogLevel::Info)
}

pub fn emit_log_line(
    service: &str,
    level: LogLevel,
    min_level: LogLevel,
    event: &str,
    fields: JsonValue,
) {
    if level < min_level {
        return;
    }
    let line = log_payload_line(service, level, event, fields);
    if level >= LogLevel::Error {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}

fn log_payload_line(service: &str, level: LogLevel, event: &str, fields: JsonValue) -> String {
    let payload = log_payload(service, level, event, fields);
    let mut line = String::from("{");
    let mut first = true;
    for key in ["ts", "service", "level", "event"] {
        if let Some(value) = payload.get(key) {
            push_json_entry(&mut line, &mut first, key, value);
        }
    }
    for (key, value) in &payload {
        if !matches!(key.as_str(), "ts" | "service" | "level" | "event") {
            push_json_entry(&mut line, &mut first, key, value);
        }
    }
    line.push('}');
    line
}

fn push_json_entry(line: &mut String, first: &mut bool, key: &str, value: &JsonValue) {
    if *first {
        *first = false;
    } else {
        line.push(',');
    }
    line.push_str(&serde_json::to_string(key).expect("serializing log key should not fail"));
    line.push(':');
    line.push_str(&serde_json::to_string(value).expect("serializing log value should not fail"));
}

fn log_payload(
    service: &str,
    level: LogLevel,
    event: &str,
    fields: JsonValue,
) -> serde_json::Map<String, JsonValue> {
    let mut payload = serde_json::Map::new();
    payload.insert("ts".to_string(), JsonValue::String(now_log_ts()));
    payload.insert(
        "service".to_string(),
        JsonValue::String(service.to_string()),
    );
    payload.insert(
        "level".to_string(),
        JsonValue::String(level.as_str().to_string()),
    );
    payload.insert("event".to_string(), JsonValue::String(event.to_string()));
    if let JsonValue::Object(extra) = fields {
        for (key, value) in extra {
            if !value.is_null() {
                payload.insert(key, value);
            }
        }
    }
    payload
}

fn now_log_ts() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn level_parse_is_case_insensitive() {
        assert_eq!(LogLevel::parse("debug"), Some(LogLevel::Debug));
        assert_eq!(LogLevel::parse("INFO"), Some(LogLevel::Info));
        assert_eq!(LogLevel::parse("Warn"), Some(LogLevel::Warn));
        assert_eq!(LogLevel::parse("error"), Some(LogLevel::Error));
        assert_eq!(LogLevel::parse("trace"), None);
    }

    #[test]
    fn level_ord_lets_us_gate() {
        assert!(LogLevel::Debug < LogLevel::Info);
        assert!(LogLevel::Info < LogLevel::Warn);
        assert!(LogLevel::Warn < LogLevel::Error);
    }

    #[test]
    fn log_payload_keeps_stable_fields_and_skips_null_extras() {
        let payload = log_payload(
            "scheduler",
            LogLevel::Warn,
            "cron_tick",
            json!({
                "namespace": "demo",
                "ignored": null
            }),
        );

        assert!(payload.get("ts").and_then(JsonValue::as_str).is_some());
        assert_eq!(payload.get("service"), Some(&json!("scheduler")));
        assert_eq!(payload.get("level"), Some(&json!("warn")));
        assert_eq!(payload.get("event"), Some(&json!("cron_tick")));
        assert_eq!(payload.get("namespace"), Some(&json!("demo")));
        assert!(!payload.contains_key("ignored"));
    }

    #[test]
    fn log_payload_line_matches_js_envelope_order() {
        let line = log_payload_line(
            "scheduler",
            LogLevel::Info,
            "started",
            json!({ "port": 7070 }),
        );

        assert!(
            line.starts_with(r#"{"ts":"#),
            "Rust structured logs should match JS envelope order: {line}"
        );
        assert!(line.contains(r#","service":"scheduler","level":"info","event":"started","#));
    }

    #[test]
    fn log_timestamp_matches_js_iso_millisecond_shape() {
        let ts = now_log_ts();
        assert_eq!(ts.len(), "2026-01-01T00:00:00.000Z".len());
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[7..8], "-");
        assert_eq!(&ts[10..11], "T");
        assert_eq!(&ts[13..14], ":");
        assert_eq!(&ts[16..17], ":");
        assert_eq!(&ts[19..20], ".");
        assert_eq!(&ts[23..24], "Z");
        assert!(ts[20..23].chars().all(|ch| ch.is_ascii_digit()));
        assert!(!ts.contains("+00:00"));
    }
}
