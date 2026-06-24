use axum::body::Body;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use std::collections::HashMap;
use wdl_rust_common::time::now_ms;

use crate::{
    AppState, WorkflowError, WorkflowResult, instance_step_summaries_key,
    instance_step_summary_index_key,
};

use super::super::{InstanceRouteKeys, eval_script, read_json_request};
use super::{STEP_SCRIPT_OK, StepRecord, StepSummary, active_claim_error};

const DEFAULT_STATUS_STEP_LIMIT: usize = 100;
const MAX_STATUS_STEP_LIMIT: usize = 1000;
const DEFAULT_REPLAY_STEP_PAGE_LIMIT: usize = 64;
const MAX_REPLAY_STEP_PAGE_LIMIT: usize = 128;

const READ_REPLAY_STEP_PAGE_SCRIPT: &str = r#"
local generation = redis.call("HGET", KEYS[1], "generation")
local token = redis.call("HGET", KEYS[1], "runToken")
local created_at_ms = redis.call("HGET", KEYS[1], "createdAtMs")
if generation ~= ARGV[1] or token ~= ARGV[2] or created_at_ms ~= ARGV[3] then
  return {0, {}}
end
local lease = tonumber(redis.call("HGET", KEYS[1], "runLeaseExpiresAtMs") or "")
if not lease then
  return {-4, {}}
end
if lease <= tonumber(ARGV[4]) then
  return {-2, {}}
end
local status = redis.call("HGET", KEYS[1], "status")
if status ~= "running" and status ~= "waiting" then
  return {-3, {}}
end
local out = {}
for i = 5, #ARGV do
  local raw = redis.call("HGET", KEYS[2], ARGV[i])
  if raw then
    table.insert(out, raw)
  else
    table.insert(out, "")
  end
end
return {1, out}
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepHistory {
    entries: Vec<StepSummary>,
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowReplayStepsRequest {
    ns: String,
    workflow_key: String,
    instance_id: String,
    generation: i64,
    created_at_ms: i64,
    run_token: String,
    start_ordinal: u32,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) async fn read_workflow_replay_request(
    body: Body,
) -> WorkflowResult<WorkflowReplayStepsRequest> {
    read_json_request(body, "Invalid replay request JSON").await
}

pub(crate) fn workflow_step_options(options: &JsonValue) -> WorkflowResult<Option<usize>> {
    let include_steps = options
        .get("includeSteps")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    if !include_steps {
        return Ok(None);
    }
    let Some(raw_limit) = options.get("stepLimit") else {
        return Ok(Some(DEFAULT_STATUS_STEP_LIMIT));
    };
    let Some(limit) = raw_limit.as_u64() else {
        return Err(WorkflowError::invalid_request(
            "status stepLimit must be an integer",
        ));
    };
    let Ok(limit) = usize::try_from(limit) else {
        return Err(WorkflowError::request_too_large(
            "status stepLimit exceeds the 1000 step limit",
        ));
    };
    if !(1..=MAX_STATUS_STEP_LIMIT).contains(&limit) {
        return Err(WorkflowError::request_too_large(
            "status stepLimit must be in [1, 1000]",
        ));
    }
    Ok(Some(limit))
}

pub(crate) async fn read_step_history(
    app: &AppState,
    ns: &str,
    workflow_key: &str,
    instance_id: &str,
    limit: usize,
) -> WorkflowResult<StepHistory> {
    let summaries_key = instance_step_summaries_key(ns, workflow_key, instance_id);
    let summary_index_key = instance_step_summary_index_key(ns, workflow_key, instance_id);
    let index_count: usize = app
        .redis
        .with_conn(async |mut conn| {
            redis::cmd("ZCARD")
                .arg(&summary_index_key)
                .query_async::<usize>(&mut conn)
                .await
        })
        .await?;
    if index_count > 0 {
        let fields: Vec<String> = app
            .redis
            .with_conn(async |mut conn| {
                redis::cmd("ZREVRANGE")
                    .arg(&summary_index_key)
                    .arg(0)
                    .arg(limit.saturating_sub(1))
                    .query_async(&mut conn)
                    .await
            })
            .await?;
        let raw: Vec<Option<String>> = app
            .redis
            .with_conn(async |mut conn| {
                let mut cmd = redis::cmd("HMGET");
                cmd.arg(&summaries_key);
                for field in &fields {
                    cmd.arg(field);
                }
                cmd.query_async(&mut conn).await
            })
            .await?;
        let mut records = Vec::with_capacity(raw.len());
        for (field, value) in fields.into_iter().zip(raw) {
            let value = value.ok_or_else(|| {
                WorkflowError::invalid_state(format!(
                    "Workflow step summary index points to missing field {field}"
                ))
            })?;
            let record: StepSummary = serde_json::from_str(&value).map_err(|err| {
                WorkflowError::invalid_state(format!("Workflow step summary is corrupt: {err}"))
            })?;
            records.push(normalize_summary(record));
        }
        records.sort_by_key(|record| record.ordinal);
        return Ok(StepHistory {
            entries: records,
            truncated: index_count > limit,
        });
    }

    let raw: HashMap<String, String> = app
        .redis
        .with_conn(async |mut conn| {
            redis::cmd("HGETALL")
                .arg(summaries_key)
                .query_async(&mut conn)
                .await
        })
        .await?;
    let mut records = Vec::with_capacity(raw.len());
    for value in raw.into_values() {
        let record: StepSummary = serde_json::from_str(&value).map_err(|err| {
            WorkflowError::invalid_state(format!("Workflow step summary is corrupt: {err}"))
        })?;
        records.push(normalize_summary(record));
    }
    records.sort_by_key(|record| record.ordinal);
    let truncated = records.len() > limit;
    if truncated {
        let drop_count = records.len() - limit;
        records.drain(0..drop_count);
    }
    let entries = records;
    Ok(StepHistory { entries, truncated })
}

fn normalize_summary(mut record: StepSummary) -> StepSummary {
    record.attempt = record.attempt.max(1);
    record.has_output = record.has_output || record.output_ref.is_some();
    record.has_error = record.has_error || record.error_ref.is_some();
    record
}

pub(crate) async fn read_replay_step_page(
    app: &AppState,
    req: WorkflowReplayStepsRequest,
) -> WorkflowResult<JsonValue> {
    let limit = req
        .limit
        .unwrap_or(DEFAULT_REPLAY_STEP_PAGE_LIMIT)
        .clamp(1, MAX_REPLAY_STEP_PAGE_LIMIT);
    let keys = InstanceRouteKeys::new(&req.ns, &req.workflow_key, &req.instance_id);
    let state_key = keys.state();
    let steps_key = keys.steps();
    let payloads_key = keys.payloads();
    let fields: Vec<String> = (0..limit)
        .map(|offset| req.start_ordinal.saturating_add(offset as u32).to_string())
        .collect();
    let now = now_ms().to_string();
    let generation = req.generation.to_string();
    let created_at_ms = req.created_at_ms.to_string();
    let mut args = vec![
        generation.as_str(),
        req.run_token.as_str(),
        created_at_ms.as_str(),
        now.as_str(),
    ];
    args.extend(fields.iter().map(String::as_str));
    let (code, raw): (i64, Vec<String>) = eval_script(
        app,
        READ_REPLAY_STEP_PAGE_SCRIPT,
        &[&state_key, &steps_key],
        &args,
    )
    .await?;
    if code != STEP_SCRIPT_OK {
        return Err(active_claim_error(code));
    }

    let mut records = Vec::new();
    for value in raw {
        if value.is_empty() {
            break;
        }
        let record: StepRecord = serde_json::from_str(&value).map_err(|err| {
            WorkflowError::invalid_state(format!("Workflow step record is corrupt: {err}"))
        })?;
        records.push(record);
    }
    let payloads = read_replay_payloads(app, &payloads_key, &records).await?;
    let entries = records
        .into_iter()
        .map(|record| replay_entry(record, &payloads))
        .collect::<WorkflowResult<Vec<_>>>()?;
    let next_ordinal = req.start_ordinal.saturating_add(entries.len() as u32);
    Ok(json!({
        "steps": entries,
        "nextOrdinal": next_ordinal,
        "done": entries.len() < limit,
    }))
}

fn replay_payload_from_map(
    payloads: &HashMap<String, JsonValue>,
    payload_ref: &str,
) -> WorkflowResult<JsonValue> {
    payloads.get(payload_ref).cloned().ok_or_else(|| {
        WorkflowError::payload_missing(format!("Workflow replay payload {payload_ref} is missing"))
    })
}

fn replay_entry(
    record: StepRecord,
    payloads: &HashMap<String, JsonValue>,
) -> WorkflowResult<JsonValue> {
    let mut output = None;
    if let Some(inline) = record.output {
        output = Some(inline);
    } else if let Some(output_ref) = &record.output_ref {
        output = Some(replay_payload_from_map(payloads, output_ref)?);
    }
    let mut error = None;
    if let Some(inline) = record.error {
        error = Some(inline);
    } else if let Some(error_ref) = &record.error_ref {
        error = Some(replay_payload_from_map(payloads, error_ref)?);
    }
    Ok(json!({
        "ordinal": record.ordinal,
        "name": record.step_name,
        "nameCount": record.name_count,
        "dependencies": record.dependencies,
        "config": record.config,
        "status": record.status,
        "attempt": record.attempt,
        "output": output,
        "error": error,
        "dueAtMs": record.due_at_ms,
    }))
}

async fn read_replay_payloads(
    app: &AppState,
    payloads_key: &str,
    records: &[StepRecord],
) -> WorkflowResult<HashMap<String, JsonValue>> {
    let mut refs = Vec::new();
    for record in records {
        if record.output.is_none()
            && let Some(output_ref) = &record.output_ref
        {
            refs.push(output_ref.clone());
        }
        if record.error.is_none()
            && let Some(error_ref) = &record.error_ref
        {
            refs.push(error_ref.clone());
        }
    }
    if refs.is_empty() {
        return Ok(HashMap::new());
    }
    let raw: Vec<Option<String>> = app
        .redis
        .with_conn(async |mut conn| {
            let mut cmd = redis::cmd("HMGET");
            cmd.arg(payloads_key);
            for payload_ref in &refs {
                cmd.arg(payload_ref);
            }
            cmd.query_async(&mut conn).await
        })
        .await?;
    let mut payloads = HashMap::with_capacity(refs.len());
    for (payload_ref, raw) in refs.into_iter().zip(raw) {
        let Some(raw) = raw else {
            return Err(WorkflowError::payload_missing(format!(
                "Workflow replay payload {payload_ref} is missing"
            )));
        };
        let parsed = serde_json::from_str::<JsonValue>(&raw).map_err(|err| {
            WorkflowError::invalid_state(format!("Workflow replay payload is corrupt: {err}"))
        })?;
        payloads.insert(payload_ref, parsed);
    }
    Ok(payloads)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_page_reads_are_active_claim_fenced() {
        assert!(READ_REPLAY_STEP_PAGE_SCRIPT.contains(r#""runLeaseExpiresAtMs""#));
        assert!(READ_REPLAY_STEP_PAGE_SCRIPT.contains(r#"lease <= tonumber(ARGV[4])"#));
        assert!(
            READ_REPLAY_STEP_PAGE_SCRIPT.contains(r#"status ~= "running" and status ~= "waiting""#)
        );
        assert!(READ_REPLAY_STEP_PAGE_SCRIPT.contains(r#"created_at_ms ~= ARGV[3]"#));
        assert!(READ_REPLAY_STEP_PAGE_SCRIPT.contains(r#"redis.call("HGET", KEYS[2], ARGV[i])"#));
    }
}
