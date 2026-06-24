use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use redis::aio::ConnectionManager;
use redis::{AsyncCommands, Value as RedisValue};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use wdl_rust_common::hash::fnv1a32;
use wdl_rust_common::identity::is_valid_runtime_load_ns;

use crate::observability::Metrics;
use crate::{AppError, AppResult, AppState, SERVICE, empty};

mod cursor;

const KV_HASH_BUCKETS: u32 = 32;
const VALUE_FIELD_PREFIX: &str = "v:";
const META_FIELD_PREFIX: &str = "m:";
const KV_KEY_MAX_BYTES: usize = 512;
const KV_BATCH_KEYS_MAX: usize = 100;
pub(crate) const KV_BATCH_RAW_BYTES_MAX: usize = 25 * 1024 * 1024;
const HMGET_WITH_RAW_BYTE_BUDGET_SCRIPT: &str = r#"
local budget = tonumber(ARGV[1])
local total = 0
for i = 2, #ARGV do
  local len = redis.call("HSTRLEN", KEYS[1], ARGV[i])
  total = total + len
  if total > budget then
    return {0, total}
  end
end
local out = {1, total}
local values = redis.call("HMGET", KEYS[1], unpack(ARGV, 2))
for i = 1, #values do
  table.insert(out, values[i])
end
return out
"#;
use cursor::{cursor_overflow_field_allowed, encode_list_cursor, existing_cursor_overflow_fields};
pub(crate) use cursor::{decode_list_cursor, normalize_list_limit};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KvParams {
    pub(crate) ns: String,
    pub(crate) id: String,
    pub(crate) key: Option<String>,
    pub(crate) ttl: Option<String>,
    pub(crate) exat: Option<String>,
    pub(crate) prefix: Option<String>,
    pub(crate) limit: Option<u64>,
    pub(crate) metadata: Option<bool>,
    // String, not u64, so the cursor format stays opaque end-to-end. SCAN
    // cursors are not promised to be u64-shaped by the Redis contract.
    pub(crate) cursor: Option<String>,
}

fn is_valid_kv_binding_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

impl KvParams {
    fn validate_scope(&self) -> AppResult<()> {
        if !is_valid_runtime_load_ns(&self.ns) {
            return Err(AppError::bad_request("invalid KV namespace"));
        }
        if !is_valid_kv_binding_id(&self.id) {
            return Err(AppError::bad_request("invalid KV binding id"));
        }
        Ok(())
    }

    fn validate_expiration(&self) -> AppResult<()> {
        if let Some(ttl) = self.ttl.as_deref() {
            require_positive_integer(ttl, "invalid KV ttl")?;
        }
        if let Some(exat) = self.exat.as_deref() {
            require_positive_integer(exat, "invalid KV exat")?;
        }
        Ok(())
    }
}

fn require_positive_integer(value: &str, message: &'static str) -> AppResult<()> {
    match value.parse::<u64>() {
        Ok(n) if n > 0 => Ok(()),
        _ => Err(AppError::bad_request(message)),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct KvBatchBody {
    keys: Vec<String>,
    metadata: Option<bool>,
}

fn validate_batch_keys(keys: &[String]) -> AppResult<()> {
    if keys.len() > KV_BATCH_KEYS_MAX {
        return Err(AppError::bad_request(format!(
            "KV batch key count exceeds {KV_BATCH_KEYS_MAX}"
        )));
    }
    for key in keys {
        validate_kv_key(key)?;
    }
    Ok(())
}

fn validate_kv_key(key: &str) -> AppResult<()> {
    if key.len() > KV_KEY_MAX_BYTES {
        return Err(AppError::bad_request(format!(
            "KV key exceeds {KV_KEY_MAX_BYTES} byte limit"
        )));
    }
    Ok(())
}

pub(crate) fn add_batch_raw_bytes(total: &mut usize, bytes: usize) -> AppResult<()> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| AppError::payload_too_large("KV batch raw byte count overflow"))?;
    if *total > KV_BATCH_RAW_BYTES_MAX {
        return Err(AppError::payload_too_large(format!(
            "KV batch raw value/metadata bytes exceed {KV_BATCH_RAW_BYTES_MAX} byte limit"
        )));
    }
    Ok(())
}

pub(crate) fn key_base(ns: &str, id: &str) -> String {
    format!("kvh:{ns}:{id}:")
}

pub(crate) fn bucket_for_key(key: &str) -> u32 {
    fnv1a32(key.as_bytes()) % KV_HASH_BUCKETS
}

pub(crate) fn hash_key(ns: &str, id: &str, bucket: u32) -> String {
    format!("{}b:{bucket}", key_base(ns, id))
}

fn hash_key_for_user_key(ns: &str, id: &str, key: &str) -> String {
    hash_key(ns, id, bucket_for_key(key))
}

fn value_field(key: &str) -> String {
    format!("{VALUE_FIELD_PREFIX}{key}")
}

fn meta_field(key: &str) -> String {
    format!("{META_FIELD_PREFIX}{key}")
}

fn grouped_hmget_commands(
    ns: &str,
    id: &str,
    keys: &[String],
    field_prefix: &str,
) -> Vec<(String, Vec<usize>, Vec<String>)> {
    grouped_hmget_commands_for_indices(ns, id, keys, 0..keys.len(), field_prefix)
}

fn grouped_hmget_commands_for_indices(
    ns: &str,
    id: &str,
    keys: &[String],
    indices: impl IntoIterator<Item = usize>,
    field_prefix: &str,
) -> Vec<(String, Vec<usize>, Vec<String>)> {
    let mut by_hash: HashMap<String, (Vec<usize>, Vec<String>)> = HashMap::new();
    for index in indices {
        let key = &keys[index];
        let redis_key = hash_key_for_user_key(ns, id, key);
        let entry = by_hash.entry(redis_key).or_default();
        entry.0.push(index);
        entry.1.push(format!("{field_prefix}{key}"));
    }
    by_hash
        .into_iter()
        .map(|(redis_key, (indices, fields))| (redis_key, indices, fields))
        .collect()
}

fn raw_bytes_too_large() -> AppError {
    AppError::payload_too_large(format!(
        "KV batch raw value/metadata bytes exceed {KV_BATCH_RAW_BYTES_MAX} byte limit"
    ))
}

fn record_kv_value_bytes(
    metrics: &Metrics,
    operation: &'static str,
    kind: &'static str,
    bytes: usize,
) {
    metrics.observe(
        "kv_value_bytes",
        &[
            ("service", SERVICE),
            ("operation", operation),
            ("kind", kind),
        ],
        bytes as f64,
    );
}

fn parse_hmget_budget_reply(
    reply: RedisValue,
    expected_values: usize,
) -> AppResult<(usize, Vec<Option<Vec<u8>>>)> {
    let RedisValue::Array(mut values) = reply else {
        return Err(AppError::internal_error("invalid KV HMGET budget response"));
    };
    if values.len() < 2 {
        return Err(AppError::internal_error("invalid KV HMGET budget arity"));
    }
    let ok = match values.first() {
        Some(RedisValue::Int(value)) => *value == 1,
        _ => return Err(AppError::internal_error("invalid KV HMGET budget flag")),
    };
    let bytes = match values.get(1) {
        Some(RedisValue::Int(value)) if *value >= 0 => *value as usize,
        _ => return Err(AppError::internal_error("invalid KV HMGET budget bytes")),
    };
    if !ok {
        return Err(raw_bytes_too_large());
    }
    if values.len() != expected_values + 2 {
        return Err(AppError::internal_error("invalid KV HMGET budget arity"));
    }
    let raw_values = values.split_off(2);
    let mut out = Vec::with_capacity(expected_values);
    for value in raw_values {
        match value {
            RedisValue::Nil => out.push(None),
            RedisValue::BulkString(bytes) => out.push(Some(bytes)),
            _ => return Err(AppError::internal_error("invalid KV HMGET value")),
        }
    }
    Ok((bytes, out))
}

async fn hmget_with_raw_byte_budget(
    conn: &mut ConnectionManager,
    total: &mut usize,
    redis_key: &str,
    fields: &[String],
) -> AppResult<Vec<Option<Vec<u8>>>> {
    if fields.is_empty() {
        return Ok(Vec::new());
    }
    // The Lua preflight is the Redis-side atomic budget gate: HSTRLEN and HMGET
    // run in one script, so over-budget batches fail before payload bytes leave
    // Redis. Callers keep a separate actual-byte counter over returned values as
    // defense-in-depth without double-counting stable data against the budget.
    let remaining = KV_BATCH_RAW_BYTES_MAX
        .checked_sub(*total)
        .ok_or_else(raw_bytes_too_large)?;
    let mut cmd = redis::cmd("EVAL");
    cmd.arg(HMGET_WITH_RAW_BYTE_BUDGET_SCRIPT)
        .arg(1)
        .arg(redis_key)
        .arg(remaining);
    for field in fields {
        cmd.arg(field);
    }
    let (bytes, values) = parse_hmget_budget_reply(cmd.query_async(conn).await?, fields.len())?;
    add_batch_raw_bytes(total, bytes)?;
    Ok(values)
}

pub(crate) fn kv_put_pipeline(
    redis_key: &str,
    value_field: &str,
    meta_field: &str,
    body: &[u8],
    metadata: Option<&[u8]>,
    ttl: &str,
    exat: &str,
) -> redis::Pipeline {
    let mut pipe = redis::pipe();
    pipe.atomic();
    if ttl.is_empty() && exat.is_empty() {
        pipe.cmd("HSET")
            .arg(redis_key)
            .arg(value_field)
            .arg(body)
            .ignore();
        if let Some(metadata) = metadata {
            pipe.cmd("HSET")
                .arg(redis_key)
                .arg(meta_field)
                .arg(metadata)
                .ignore();
            pipe.cmd("HPERSIST")
                .arg(redis_key)
                .arg("FIELDS")
                .arg(2)
                .arg(value_field)
                .arg(meta_field)
                .ignore();
        } else {
            pipe.cmd("HDEL").arg(redis_key).arg(meta_field).ignore();
            pipe.cmd("HPERSIST")
                .arg(redis_key)
                .arg("FIELDS")
                .arg(1)
                .arg(value_field)
                .ignore();
        }
    } else {
        let mut hsetex = redis::cmd("HSETEX");
        hsetex.arg(redis_key);
        if !ttl.is_empty() {
            hsetex.arg("EX").arg(ttl);
        } else {
            hsetex.arg("EXAT").arg(exat);
        }
        if let Some(metadata) = metadata {
            hsetex
                .arg("FIELDS")
                .arg(2)
                .arg(value_field)
                .arg(body)
                .arg(meta_field)
                .arg(metadata);
        } else {
            hsetex.arg("FIELDS").arg(1).arg(value_field).arg(body);
            pipe.cmd("HDEL").arg(redis_key).arg(meta_field).ignore();
        }
        pipe.add_command(hsetex).ignore();
    }
    pipe
}

fn field_to_user_key(field: &str) -> AppResult<&str> {
    field
        .strip_prefix(VALUE_FIELD_PREFIX)
        .ok_or_else(|| AppError::internal_error("invalid KV field"))
}

fn decode_metadata(bytes: Option<Vec<u8>>) -> AppResult<Option<Value>> {
    bytes
        .map(|raw| serde_json::from_slice::<Value>(&raw).map_err(AppError::internal_json))
        .transpose()
}

pub(crate) fn escape_glob_literal(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

pub(crate) async fn kv_get(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
) -> AppResult<Response> {
    q.validate_scope()?;
    let key = q.key.unwrap_or_default();
    validate_kv_key(&key)?;
    let redis_key = hash_key_for_user_key(&q.ns, &q.id, &key);
    let field = value_field(&key);
    let bytes: Option<Vec<u8>> = state
        .with_redis(async |mut conn| conn.hget(redis_key, field).await)
        .await?;
    let Some(value) = bytes else {
        return Ok(empty(StatusCode::NOT_FOUND));
    };

    let len = value.len();
    record_kv_value_bytes(state.metrics(), "get", "value", len);
    let mut response = Response::new(Body::from(value));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&len.to_string()).unwrap(),
    );
    Ok(response)
}

pub(crate) async fn kv_get_with_metadata(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
) -> AppResult<Json<Value>> {
    q.validate_scope()?;
    let key = q.key.unwrap_or_default();
    validate_kv_key(&key)?;
    let redis_key = hash_key_for_user_key(&q.ns, &q.id, &key);
    let value = value_field(&key);
    let meta = meta_field(&key);
    let (bytes, metadata): (Option<Vec<u8>>, Option<Vec<u8>>) = state
        .with_redis(async |mut conn| {
            redis::cmd("HMGET")
                .arg(redis_key)
                .arg(value)
                .arg(meta)
                .query_async(&mut conn)
                .await
        })
        .await?;
    let Some(bytes) = bytes else {
        return Ok(Json(json!({
            "value_b64": null,
            "metadata": null,
        })));
    };
    record_kv_value_bytes(state.metrics(), "get_with_metadata", "value", bytes.len());
    if let Some(metadata) = metadata.as_ref() {
        record_kv_value_bytes(
            state.metrics(),
            "get_with_metadata",
            "metadata",
            metadata.len(),
        );
    }
    Ok(Json(json!({
        "value_b64": STANDARD.encode(bytes),
        "metadata": decode_metadata(metadata)?,
    })))
}

pub(crate) async fn kv_get_batch(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
    Json(body): Json<KvBatchBody>,
) -> AppResult<Json<Value>> {
    q.validate_scope()?;
    validate_batch_keys(&body.keys)?;
    let include_metadata = body.metadata.unwrap_or(false);
    let keys = body.keys;
    let mut conn = state.redis();
    let mut preflight_raw_bytes = 0_usize;
    let mut actual_raw_bytes = 0_usize;
    let mut values: Vec<Option<Vec<u8>>> = vec![None; keys.len()];
    for (redis_key, indices, fields) in
        grouped_hmget_commands(&q.ns, &q.id, &keys, VALUE_FIELD_PREFIX)
    {
        let batch =
            hmget_with_raw_byte_budget(&mut conn, &mut preflight_raw_bytes, &redis_key, &fields)
                .await?;
        for (offset, value) in batch.into_iter().enumerate() {
            if let Some(bytes) = value.as_ref() {
                add_batch_raw_bytes(&mut actual_raw_bytes, bytes.len())?;
            }
            values[indices[offset]] = value;
        }
    }
    let mut metadata: Vec<Option<Value>> = vec![None; keys.len()];
    if include_metadata {
        let present_value_indices = values
            .iter()
            .enumerate()
            .filter_map(|(index, value)| value.as_ref().map(|_| index));
        for (redis_key, indices, fields) in grouped_hmget_commands_for_indices(
            &q.ns,
            &q.id,
            &keys,
            present_value_indices,
            META_FIELD_PREFIX,
        ) {
            let batch = hmget_with_raw_byte_budget(
                &mut conn,
                &mut preflight_raw_bytes,
                &redis_key,
                &fields,
            )
            .await?;
            for (offset, raw) in batch.into_iter().enumerate() {
                let index = indices[offset];
                if values[index].is_none() {
                    continue;
                }
                if let Some(bytes) = raw.as_ref() {
                    add_batch_raw_bytes(&mut actual_raw_bytes, bytes.len())?;
                }
                metadata[index] = decode_metadata(raw)?;
            }
        }
    }
    record_kv_value_bytes(state.metrics(), "get_batch", "raw_batch", actual_raw_bytes);
    let mut entries = Vec::with_capacity(keys.len());
    for (index, key) in keys.into_iter().enumerate() {
        let value = values[index].take();
        entries.push(json!({
            "key": key,
            "value_b64": value.map(|bytes| STANDARD.encode(bytes)),
            "metadata": metadata[index].take(),
        }));
    }
    Ok(Json(json!({ "entries": entries })))
}

pub(crate) async fn kv_put(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    q.validate_scope()?;
    q.validate_expiration()?;
    let key = q.key.unwrap_or_default();
    validate_kv_key(&key)?;
    let metadata = headers
        .get("x-kv-metadata-b64")
        .map(|value| {
            value
                .to_str()
                .map_err(|_| AppError::bad_request("invalid metadata base64"))
                .and_then(|raw| {
                    STANDARD
                        .decode(raw)
                        .map_err(|_| AppError::bad_request("invalid metadata base64"))
                })
        })
        .transpose()?;
    let redis_key = hash_key_for_user_key(&q.ns, &q.id, &key);
    let value = value_field(&key);
    let meta = meta_field(&key);
    let ttl = q.ttl.unwrap_or_default();
    let exat = q.exat.unwrap_or_default();
    state
        .with_redis(async |mut conn| {
            kv_put_pipeline(
                &redis_key,
                &value,
                &meta,
                body.as_ref(),
                metadata.as_deref(),
                &ttl,
                &exat,
            )
            .query_async::<()>(&mut conn)
            .await
        })
        .await?;
    record_kv_value_bytes(state.metrics(), "put", "value", body.len());
    if let Some(metadata) = metadata.as_ref() {
        record_kv_value_bytes(state.metrics(), "put", "metadata", metadata.len());
    }
    Ok(empty(StatusCode::NO_CONTENT))
}

pub(crate) async fn kv_delete(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
) -> AppResult<Response> {
    q.validate_scope()?;
    let key = q.key.unwrap_or_default();
    validate_kv_key(&key)?;
    let redis_key = hash_key_for_user_key(&q.ns, &q.id, &key);
    let value = value_field(&key);
    let meta = meta_field(&key);
    let _: i64 = state
        .with_redis(async |mut conn| conn.hdel(redis_key, (value, meta)).await)
        .await?;
    Ok(empty(StatusCode::NO_CONTENT))
}

pub(crate) async fn kv_list(
    State(state): State<AppState>,
    Query(q): Query<KvParams>,
) -> AppResult<Json<Value>> {
    q.validate_scope()?;
    let limit = normalize_list_limit(q.limit) as usize;
    let (mut bucket, mut scan_cursor, mut overflow) = decode_list_cursor(q.cursor)?;
    let prefix = q.prefix.unwrap_or_default();
    validate_kv_key(&prefix)?;
    let include_metadata = q.metadata.unwrap_or(false);
    let pattern = format!("{VALUE_FIELD_PREFIX}{}*", escape_glob_literal(&prefix));
    let mut raw_fields = Vec::new();
    while raw_fields.len() < limit && bucket < KV_HASH_BUCKETS {
        let redis_key = hash_key(&q.ns, &q.id, bucket);
        overflow.retain(|field| cursor_overflow_field_allowed(field, &prefix));
        if !overflow.is_empty() {
            let remaining = limit - raw_fields.len();
            let pending_overflow = if overflow.len() > remaining {
                overflow.split_off(remaining)
            } else {
                Vec::new()
            };
            raw_fields.extend(
                existing_cursor_overflow_fields(&state, redis_key.clone(), overflow).await?,
            );
            overflow = pending_overflow;
            if !overflow.is_empty() {
                break;
            }
            if scan_cursor == "0" {
                bucket += 1;
                continue;
            }
        }
        let pattern_arg = pattern.clone();
        let cursor_arg = scan_cursor.clone();
        let (next_cursor, batch): (String, Vec<String>) = state
            .with_redis(async |mut conn| {
                redis::cmd("HSCAN")
                    .arg(redis_key)
                    .arg(cursor_arg)
                    .arg("MATCH")
                    .arg(pattern_arg)
                    .arg("COUNT")
                    .arg(limit)
                    .arg("NOVALUES")
                    .query_async(&mut conn)
                    .await
            })
            .await?;
        scan_cursor = next_cursor;
        let remaining = limit - raw_fields.len();
        if batch.len() <= remaining {
            raw_fields.extend(batch);
            if scan_cursor == "0" {
                bucket += 1;
            }
        } else {
            raw_fields.extend(batch[..remaining].iter().cloned());
            overflow.extend(batch[remaining..].iter().cloned());
            break;
        }
    }
    let user_keys = raw_fields
        .into_iter()
        .map(|field| field_to_user_key(&field).map(str::to_string))
        .collect::<AppResult<Vec<_>>>()?;
    let mut metadata = if include_metadata {
        let mut conn = state.redis();
        let mut preflight_raw_bytes = 0_usize;
        let mut actual_raw_bytes = 0_usize;
        let mut values: Vec<Option<Value>> = vec![None; user_keys.len()];
        for (redis_key, indices, fields) in
            grouped_hmget_commands(&q.ns, &q.id, &user_keys, META_FIELD_PREFIX)
        {
            let batch = hmget_with_raw_byte_budget(
                &mut conn,
                &mut preflight_raw_bytes,
                &redis_key,
                &fields,
            )
            .await?;
            for (offset, raw) in batch.into_iter().enumerate() {
                if let Some(bytes) = raw.as_ref() {
                    add_batch_raw_bytes(&mut actual_raw_bytes, bytes.len())?;
                }
                values[indices[offset]] = decode_metadata(raw)?;
            }
        }
        record_kv_value_bytes(state.metrics(), "list", "metadata_batch", actual_raw_bytes);
        values
    } else {
        Vec::new()
    };
    let keys = user_keys
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            if include_metadata {
                json!({ "name": name, "metadata": metadata[index].take() })
            } else {
                json!({ "name": name })
            }
        })
        .collect::<Vec<_>>();
    if bucket >= KV_HASH_BUCKETS && overflow.is_empty() {
        Ok(Json(json!({ "keys": keys, "list_complete": true })))
    } else {
        Ok(Json(json!({
            "keys": keys,
            "list_complete": false,
            "cursor": encode_list_cursor(bucket, scan_cursor, overflow)?,
        })))
    }
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD;
    use serde_json::json;

    use super::*;
    use crate::kv::cursor::{
        KV_LIST_CURSOR_OVERFLOW_MAX, KV_LIST_CURSOR_PREFIX, KV_LIST_LIMIT_DEFAULT,
        KV_LIST_LIMIT_MAX,
    };
    use crate::test_support::parse_packed_commands;

    #[test]
    fn escape_glob_literal_escapes_scan_wildcards() {
        assert_eq!(escape_glob_literal(r"a*b?c[d\e]"), r"a\*b\?c\[d\\e]");
    }

    #[test]
    fn kv_batch_raw_byte_budget_rejects_aggregate_large_values() {
        let mut total = 0;
        add_batch_raw_bytes(&mut total, KV_BATCH_RAW_BYTES_MAX).unwrap();
        assert_eq!(total, KV_BATCH_RAW_BYTES_MAX);

        let err = add_batch_raw_bytes(&mut total, 1).unwrap_err();
        assert_eq!(err.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(err.code, "response_too_large");
        assert!(
            err.message
                .contains("KV batch raw value/metadata bytes exceed")
        );
    }

    #[test]
    fn kv_value_size_metric_uses_bounded_labels() {
        let metrics = Metrics::default();
        record_kv_value_bytes(&metrics, "put", "value", 12);
        record_kv_value_bytes(&metrics, "get_batch", "raw_batch", 34);

        let body = metrics.render_prometheus();
        assert!(body.contains("# TYPE wdl_kv_value_bytes summary"));
        assert!(body.contains(
            r#"wdl_kv_value_bytes_count{kind="value",operation="put",service="redis-proxy"} 1"#
        ));
        assert!(body.contains(
            r#"wdl_kv_value_bytes_sum{kind="raw_batch",operation="get_batch",service="redis-proxy"} 34"#
        ));
    }

    #[test]
    fn hmget_budget_reply_parses_values_and_budget_rejections() {
        let (bytes, values) = parse_hmget_budget_reply(
            RedisValue::Array(vec![
                RedisValue::Int(1),
                RedisValue::Int(3),
                RedisValue::BulkString(b"one".to_vec()),
                RedisValue::Nil,
            ]),
            2,
        )
        .unwrap();
        assert_eq!(bytes, 3);
        assert_eq!(values, vec![Some(b"one".to_vec()), None]);

        let err = parse_hmget_budget_reply(
            RedisValue::Array(vec![RedisValue::Int(0), RedisValue::Int(26 * 1024 * 1024)]),
            3,
        )
        .unwrap_err();
        assert_eq!(err.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(err.code, "response_too_large");

        let err = parse_hmget_budget_reply(
            RedisValue::Array(vec![RedisValue::Int(1), RedisValue::Int(3)]),
            1,
        )
        .unwrap_err();
        assert_eq!(err.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(err.code, "internal_error");
    }

    #[test]
    fn kv_batch_get_checks_budget_between_value_reads() {
        let source = include_str!("kv.rs");
        let start = source
            .find("pub(crate) async fn kv_get_batch")
            .expect("kv_get_batch route must exist");
        let end = source[start..]
            .find("pub(crate) async fn kv_put")
            .expect("kv_put should follow kv_get_batch")
            + start;
        let helper = &source[start..end];
        assert!(
            helper.matches("hmget_with_raw_byte_budget").count() >= 2,
            "kv_get_batch must atomically budget-check value and metadata HMGET payloads"
        );
        assert!(
            helper.matches("add_batch_raw_bytes").count() >= 2,
            "kv_get_batch must also re-check actual HMGET payload bytes after reading"
        );
        assert!(
            !helper.contains("redis::pipe"),
            "kv_get_batch must not pipeline every bucket before checking the aggregate byte budget"
        );
        assert!(
            source.contains("redis.call(\"HMGET\""),
            "the atomic KV budget helper should batch reads with Redis HMGET"
        );
    }

    #[test]
    fn kv_list_metadata_batches_metadata_reads() {
        let source = include_str!("kv.rs");
        let start = source
            .find("pub(crate) async fn kv_list")
            .expect("kv_list route must exist");
        let end = source[start..]
            .find("#[cfg(test)]")
            .expect("tests should follow kv_list")
            + start;
        let helper = &source[start..end];
        assert!(
            helper.contains("grouped_hmget_commands"),
            "kv_list metadata reads should group metadata fields by hash bucket"
        );
        assert!(
            helper.contains("hmget_with_raw_byte_budget"),
            "kv_list metadata reads must atomically budget-check raw metadata bytes before returning payloads"
        );
        assert!(
            helper.contains("add_batch_raw_bytes"),
            "kv_list metadata reads must also re-check actual HMGET payload bytes"
        );
    }

    #[test]
    fn kv_params_parses_cursor_as_string_not_u64() {
        let q: KvParams = serde_urlencoded::from_str("ns=t&id=k&cursor=42").unwrap();
        assert_eq!(q.cursor.as_deref(), Some("42"));

        let q: KvParams = serde_urlencoded::from_str("ns=t&id=k&cursor=opaque-token").unwrap();
        assert_eq!(q.cursor.as_deref(), Some("opaque-token"));

        let q: KvParams = serde_urlencoded::from_str("ns=t&id=k").unwrap();
        assert!(q.cursor.is_none());
    }

    #[test]
    fn kv_params_validate_runtime_load_namespace_and_binding_id() {
        let valid: KvParams = serde_urlencoded::from_str("ns=demo&id=cache-1").unwrap();
        valid.validate_scope().unwrap();
        let system: KvParams = serde_urlencoded::from_str("ns=__system__&id=cache").unwrap();
        system.validate_scope().unwrap();
        let platform: KvParams = serde_urlencoded::from_str("ns=__platform__&id=cache").unwrap();
        platform.validate_scope().unwrap();

        for raw in [
            "ns=admin&id=cache",
            "ns=__community__&id=cache",
            "ns=bad:ns&id=cache",
            "ns=demo&id=bad:id",
            "ns=demo&id=_bad",
            "ns=demo&id=Bad",
            "ns=demo&id=bad_1",
        ] {
            let q: KvParams = serde_urlencoded::from_str(raw).unwrap();
            let err = q.validate_scope().unwrap_err();
            assert_eq!(err.status, StatusCode::BAD_REQUEST, "{raw}");
        }
    }

    #[test]
    fn kv_keys_are_limited_to_cloudflare_compatible_512_bytes() {
        let valid = "x".repeat(KV_KEY_MAX_BYTES);
        validate_kv_key(&valid).unwrap();

        let oversized = "x".repeat(KV_KEY_MAX_BYTES + 1);
        let err = validate_kv_key(&oversized).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert!(err.message.contains("KV key exceeds 512 byte limit"));

        let multibyte = "é".repeat(257);
        let err = validate_kv_key(&multibyte).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);

        let batch_err = validate_batch_keys(&[valid, oversized]).unwrap_err();
        assert_eq!(batch_err.status, StatusCode::BAD_REQUEST);
        assert!(batch_err.message.contains("KV key exceeds 512 byte limit"));
    }

    #[test]
    fn kv_list_prefix_uses_kv_key_byte_limit() {
        let source = include_str!("kv.rs");
        let start = source
            .find("pub(crate) async fn kv_list")
            .expect("kv_list route must exist");
        let end = source[start..]
            .find("let include_metadata")
            .expect("kv_list prefix validation should happen before HSCAN setup")
            + start;
        assert!(
            source[start..end].contains("validate_kv_key(&prefix)?"),
            "kv_list must reject oversized prefixes before composing the HSCAN pattern"
        );

        let oversized = "x".repeat(KV_KEY_MAX_BYTES + 1);
        let q = KvParams {
            ns: "tenant".to_string(),
            id: "store".to_string(),
            key: None,
            ttl: None,
            exat: None,
            prefix: Some(oversized),
            limit: None,
            metadata: None,
            cursor: None,
        };
        let prefix = q.prefix.unwrap_or_default();
        let err = validate_kv_key(&prefix).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert!(err.message.contains("KV key exceeds 512 byte limit"));
    }

    #[test]
    fn kv_list_limit_is_clamped_for_scan_work() {
        assert_eq!(normalize_list_limit(None), KV_LIST_LIMIT_DEFAULT);
        assert_eq!(normalize_list_limit(Some(0)), 1);
        assert_eq!(normalize_list_limit(Some(1)), 1);
        assert_eq!(normalize_list_limit(Some(999)), 999);
        assert_eq!(
            normalize_list_limit(Some(KV_LIST_LIMIT_MAX)),
            KV_LIST_LIMIT_MAX
        );
        assert_eq!(
            normalize_list_limit(Some(KV_LIST_LIMIT_MAX + 1)),
            KV_LIST_LIMIT_MAX
        );
        assert_eq!(normalize_list_limit(Some(u64::MAX)), KV_LIST_LIMIT_MAX);
    }

    #[test]
    fn kv_list_cursor_rejects_oversized_overflow() {
        let raw = serde_json::to_vec(&json!({
            "bucket": 0,
            "scan": "0",
            "overflow": vec!["key"; KV_LIST_CURSOR_OVERFLOW_MAX + 1],
        }))
        .unwrap();
        let cursor = format!(
            "{KV_LIST_CURSOR_PREFIX}{}",
            BASE64_URL_SAFE_NO_PAD.encode(raw)
        );
        let err = decode_list_cursor(Some(cursor)).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
    }

    #[test]
    fn kv_hash_keys_are_bucketed_by_user_key() {
        let bucket = bucket_for_key("user-key");
        assert!(bucket < 256);
        assert_eq!(bucket_for_key("user-key"), bucket);
        assert_eq!(
            hash_key("tenant", "binding", bucket),
            format!("kvh:tenant:binding:b:{bucket}")
        );
    }

    #[test]
    fn kv_list_cursor_rejects_legacy_raw_scan_cursors() {
        let err = decode_list_cursor(Some("42".to_string())).unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
    }

    #[test]
    fn kv_list_cursor_overflow_existence_probe_does_not_fetch_values() {
        let source = include_str!("kv/cursor.rs");
        let start = source
            .find("async fn existing_cursor_overflow_fields")
            .expect("existing_cursor_overflow_fields helper must exist");
        let helper = &source[start..];
        assert!(
            !helper.contains("candidates.clone()"),
            "cursor overflow validation should not clone the overflow candidate vector"
        );
        assert!(
            !helper.contains("\"MGET\""),
            "cursor overflow validation must not fetch KV values"
        );
        assert!(
            helper.contains("\"HEXISTS\""),
            "cursor overflow validation should only probe field existence"
        );
    }

    #[test]
    fn kv_list_metadata_checks_budget_between_metadata_reads() {
        let source = include_str!("kv.rs");
        let start = source
            .find("pub(crate) async fn kv_list")
            .expect("kv_list route must exist");
        let end = source[start..]
            .find("#[cfg(test)]")
            .expect("test module should follow kv_list")
            + start;
        let helper = &source[start..end];
        assert!(
            helper.contains("hmget_with_raw_byte_budget"),
            "kv_list metadata must enforce the aggregate raw metadata byte budget inside the HMGET helper"
        );
        assert!(
            helper.contains("add_batch_raw_bytes"),
            "kv_list metadata must re-check actual HMGET payload bytes after reading"
        );
        assert!(
            !helper.contains("redis::pipe"),
            "kv_list metadata must not pipeline all metadata before checking the aggregate byte budget"
        );
    }

    #[test]
    fn kv_put_pipeline_preserves_value_and_metadata_ttl_contract() {
        let commands = parse_packed_commands(
            &kv_put_pipeline("hash", "v:k", "m:k", b"value", None, "", "").get_packed_pipeline(),
        );
        assert_eq!(commands[0][0], "MULTI");
        assert_eq!(commands[1], ["HSET", "hash", "v:k", "value"]);
        assert_eq!(commands[2], ["HDEL", "hash", "m:k"]);
        assert_eq!(commands[3], ["HPERSIST", "hash", "FIELDS", "1", "v:k"]);
        assert_eq!(commands[4][0], "EXEC");

        let commands = parse_packed_commands(
            &kv_put_pipeline("hash", "v:k", "m:k", b"value", Some(b"{\"a\":1}"), "", "")
                .get_packed_pipeline(),
        );
        assert_eq!(commands[1], ["HSET", "hash", "v:k", "value"]);
        assert_eq!(commands[2], ["HSET", "hash", "m:k", "{\"a\":1}"]);
        assert_eq!(
            commands[3],
            ["HPERSIST", "hash", "FIELDS", "2", "v:k", "m:k"]
        );

        let commands = parse_packed_commands(
            &kv_put_pipeline("hash", "v:k", "m:k", b"value", None, "60", "").get_packed_pipeline(),
        );
        assert_eq!(commands[1], ["HDEL", "hash", "m:k"]);
        assert_eq!(
            commands[2],
            ["HSETEX", "hash", "EX", "60", "FIELDS", "1", "v:k", "value"]
        );

        let commands = parse_packed_commands(
            &kv_put_pipeline(
                "hash",
                "v:k",
                "m:k",
                b"value",
                Some(b"{\"a\":1}"),
                "",
                "1700000000",
            )
            .get_packed_pipeline(),
        );
        assert_eq!(
            commands[1],
            [
                "HSETEX",
                "hash",
                "EXAT",
                "1700000000",
                "FIELDS",
                "2",
                "v:k",
                "value",
                "m:k",
                "{\"a\":1}"
            ]
        );
    }

    #[test]
    fn kv_params_validate_expiration_rejects_non_positive_or_non_integer_values() {
        let valid = KvParams {
            ns: "tenant".to_string(),
            id: "store".to_string(),
            key: Some("key".to_string()),
            ttl: Some("60".to_string()),
            exat: Some("1700000000".to_string()),
            prefix: None,
            limit: None,
            metadata: None,
            cursor: None,
        };
        assert!(valid.validate_expiration().is_ok());

        for (ttl, exat) in [
            (Some("0"), None),
            (Some("-1"), None),
            (Some("1.5"), None),
            (Some("abc"), None),
            (None, Some("0")),
            (None, Some("-1")),
            (None, Some("1.5")),
            (None, Some("abc")),
        ] {
            let params = KvParams {
                ns: "tenant".to_string(),
                id: "store".to_string(),
                key: Some("key".to_string()),
                ttl: ttl.map(str::to_string),
                exat: exat.map(str::to_string),
                prefix: None,
                limit: None,
                metadata: None,
                cursor: None,
            };
            assert!(params.validate_expiration().is_err());
        }
    }
}
