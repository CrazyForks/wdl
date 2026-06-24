use serde_json::{Map, Value};

pub fn fields_with_error(
    fields: Value,
    error_name: &str,
    error_message: impl Into<String>,
) -> Value {
    let mut fields = match fields {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    fields.insert(
        "error_name".to_string(),
        Value::String(error_name.to_string()),
    );
    fields.insert(
        "error_message".to_string(),
        Value::String(error_message.into()),
    );
    Value::Object(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fields_with_error_preserves_existing_object_fields() {
        assert_eq!(
            fields_with_error(json!({ "route": "tick" }), "Error", "bad request"),
            json!({
                "route": "tick",
                "error_name": "Error",
                "error_message": "bad request",
            })
        );
    }

    #[test]
    fn fields_with_error_treats_non_object_fields_as_empty() {
        assert_eq!(
            fields_with_error(Value::Null, "RedisError", "connection closed"),
            json!({
                "error_name": "RedisError",
                "error_message": "connection closed",
            })
        );
    }
}
