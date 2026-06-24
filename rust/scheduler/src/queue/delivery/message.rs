use redis::Value;
use redis::streams::StreamId;

use super::super::{QueueMessage, RuntimeMessage, StreamEntry};

pub(crate) fn value_to_string(value: &Value) -> String {
    match value {
        Value::BulkString(bytes) => String::from_utf8_lossy(bytes).to_string(),
        Value::SimpleString(s) => s.clone(),
        Value::Okay => "OK".to_string(),
        Value::Int(n) => n.to_string(),
        Value::Double(n) => n.to_string(),
        Value::Boolean(v) => v.to_string(),
        Value::Nil => String::new(),
        _ => String::new(),
    }
}

pub(crate) fn stream_id_to_entry(id: StreamId) -> StreamEntry {
    let fields = id
        .map
        .iter()
        .map(|(key, value)| (key.clone(), value_to_string(value)))
        .collect();
    StreamEntry { id: id.id, fields }
}

pub(crate) fn entries_to_messages(entries: Vec<StreamEntry>, now: i64) -> Vec<QueueMessage> {
    let now = now.to_string();
    entries
        .into_iter()
        .map(|entry| QueueMessage {
            stream_id: entry.id.clone(),
            id: entry
                .fields
                .get("id")
                .cloned()
                .unwrap_or_else(|| entry.id.clone()),
            body_b64: entry.fields.get("body_b64").cloned().unwrap_or_default(),
            content_type: entry
                .fields
                .get("content_type")
                .cloned()
                .unwrap_or_else(|| "json".to_string()),
            attempts: entry
                .fields
                .get("attempts")
                .cloned()
                .unwrap_or_else(|| "0".to_string()),
            first_seen_ms: entry
                .fields
                .get("first_seen_ms")
                .cloned()
                .unwrap_or_else(|| now.clone()),
        })
        .collect()
}

pub(crate) fn messages_for_runtime(messages: &[QueueMessage]) -> Vec<RuntimeMessage> {
    messages
        .iter()
        .map(|msg| RuntimeMessage {
            id: msg.id.clone(),
            body_b64: msg.body_b64.clone(),
            content_type: msg.content_type.clone(),
            attempts: msg.attempts.clone(),
            first_seen_ms: msg.first_seen_ms.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn str_map(items: &[(&str, &str)]) -> HashMap<String, String> {
        items
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn msg(id: &str, stream_id: &str, attempts: &str) -> QueueMessage {
        QueueMessage {
            stream_id: stream_id.to_string(),
            id: id.to_string(),
            body_b64: "aGVsbG8=".to_string(),
            content_type: "text".to_string(),
            attempts: attempts.to_string(),
            first_seen_ms: "1699999999999".to_string(),
        }
    }

    #[test]
    fn entries_to_messages_preserves_stream_fields_and_defaults() {
        let entries = vec![
            StreamEntry {
                id: "1700000000000-0".to_string(),
                fields: str_map(&[
                    ("id", "user-chosen"),
                    ("body_b64", "aGVsbG8="),
                    ("content_type", "text"),
                    ("attempts", "2"),
                    ("first_seen_ms", "1699999999999"),
                ]),
            },
            StreamEntry {
                id: "1700000000001-0".to_string(),
                fields: str_map(&[("body_b64", "")]),
            },
        ];
        let messages = entries_to_messages(entries, 1_234_567_890_000);
        assert_eq!(messages[0].stream_id, "1700000000000-0");
        assert_eq!(messages[0].id, "user-chosen");
        assert_eq!(messages[0].body_b64, "aGVsbG8=");
        assert_eq!(messages[0].content_type, "text");
        assert_eq!(messages[0].attempts, "2");
        assert_eq!(messages[0].first_seen_ms, "1699999999999");
        assert_eq!(messages[1].stream_id, "1700000000001-0");
        assert_eq!(messages[1].id, "1700000000001-0");
        assert_eq!(messages[1].content_type, "json");
        assert_eq!(messages[1].attempts, "0");
        assert_eq!(messages[1].first_seen_ms, "1234567890000");
    }

    #[test]
    fn messages_for_runtime_drops_stream_id() {
        let runtime = messages_for_runtime(&[msg("m1", "1700000000000-0", "1")]);
        assert_eq!(runtime.len(), 1);
        assert_eq!(runtime[0].id, "m1");
        assert_eq!(runtime[0].body_b64, "aGVsbG8=");
        assert_eq!(runtime[0].content_type, "text");
        assert_eq!(runtime[0].attempts, "1");
        assert_eq!(runtime[0].first_seen_ms, "1699999999999");
    }
}
