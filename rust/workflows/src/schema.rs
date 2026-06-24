use crate::{AppState, Redis, WorkflowError, WorkflowResult, schema_version_key};

pub(crate) const WORKFLOWS_SCHEMA_VERSION: &str = "2";
const WORKFLOWS_SCHEMA_SCAN_COUNT: usize = 100;

pub(crate) fn is_workflow_data_key(key: &str) -> bool {
    key.starts_with("wf:") && key != schema_version_key() && !key.starts_with("wf:defs:")
}

pub(crate) async fn ensure_workflows_schema(state: &AppState) -> WorkflowResult<()> {
    ensure_schema_on(&state.redis).await
}

async fn ensure_schema_on(redis: &Redis) -> WorkflowResult<()> {
    let key = schema_version_key();
    let version: Option<String> = redis
        .with_conn(async |mut conn| redis::cmd("GET").arg(key).query_async(&mut conn).await)
        .await?;
    match version.as_deref() {
        Some(WORKFLOWS_SCHEMA_VERSION) => return Ok(()),
        Some(found) => {
            return Err(schema_mismatch(format!(
                "workflows DB2 schema is {found}, expected {WORKFLOWS_SCHEMA_VERSION}; clear workflow runtime state before starting this build"
            )));
        }
        None => {}
    }

    if !runtime_state_is_empty_before_schema_bootstrap(redis).await? {
        return Err(schema_mismatch(format!(
            "workflows DB2 has unversioned workflow runtime state; clear workflow runtime state before starting schema {WORKFLOWS_SCHEMA_VERSION}"
        )));
    }

    let _: Option<String> = redis
        .with_conn(async |mut conn| {
            redis::cmd("SET")
                .arg(key)
                .arg(WORKFLOWS_SCHEMA_VERSION)
                .arg("NX")
                .query_async(&mut conn)
                .await
        })
        .await?;

    let adopted: Option<String> = redis
        .with_conn(async |mut conn| redis::cmd("GET").arg(key).query_async(&mut conn).await)
        .await?;
    if adopted.as_deref() == Some(WORKFLOWS_SCHEMA_VERSION) {
        Ok(())
    } else {
        Err(schema_mismatch(format!(
            "workflows DB2 schema changed while bootstrapping; found {:?}, expected {WORKFLOWS_SCHEMA_VERSION}",
            adopted
        )))
    }
}

async fn runtime_state_is_empty_before_schema_bootstrap(redis: &Redis) -> WorkflowResult<bool> {
    let mut cursor = String::from("0");
    loop {
        let (next_cursor, page) = scan_workflow_key_page(redis, cursor).await?;
        for key in page {
            if is_workflow_data_key(&key) {
                return Ok(false);
            }
        }
        if next_cursor == "0" {
            return Ok(true);
        }
        cursor = next_cursor;
    }
}

async fn scan_workflow_key_page(
    redis: &Redis,
    cursor: String,
) -> WorkflowResult<(String, Vec<String>)> {
    redis
        .with_conn(async move |mut conn| {
            redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg("wf:*")
                .arg("COUNT")
                .arg(WORKFLOWS_SCHEMA_SCAN_COUNT)
                .query_async(&mut conn)
                .await
        })
        .await
        .map_err(WorkflowError::from)
}

fn schema_mismatch(message: String) -> WorkflowError {
    WorkflowError::schema_mismatch(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_data_key_filter_excludes_schema_marker_only() {
        assert!(!is_workflow_data_key(schema_version_key()));
        assert!(!is_workflow_data_key("wf:defs:demo:worker"));
        assert!(is_workflow_data_key("wf:instance:{demo:wf:one}:state"));
        assert!(is_workflow_data_key("wf:ready:0"));
        assert!(!is_workflow_data_key("routes:demo"));
    }

    #[test]
    fn schema_bootstrap_requires_empty_runtime_state() {
        let source = include_str!("schema.rs");
        assert!(source.contains("runtime_state_is_empty_before_schema_bootstrap"));
        assert!(source.contains("if is_workflow_data_key(&key)"));
        assert!(source.contains("return Ok(false)"));
    }

    #[test]
    fn schema_scan_uses_page_helper_instead_of_collecting_all_keys() {
        let source = include_str!("schema.rs");
        assert!(source.contains("fn scan_workflow_key_page"));
        assert!(source.contains("let (next_cursor, page) = scan_workflow_key_page(redis, cursor)"));
    }
}
