use crate::{AppState, Redis};
use redis::AsyncCommands;

async fn scan_keys_on(redis: &Redis, pattern: &str) -> Result<Vec<String>, redis::RedisError> {
    let mut cursor = 0_u64;
    let mut keys = Vec::new();
    loop {
        let pattern = pattern.to_string();
        let (next, batch): (u64, Vec<String>) = redis
            .with_conn(async |mut conn| {
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(pattern)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(&mut conn)
                    .await
            })
            .await?;
        keys.extend(batch);
        cursor = next;
        if cursor == 0 {
            break;
        }
    }
    Ok(keys)
}

async fn indexed_keys_on(
    redis: &Redis,
    index_key: &str,
    pattern: &str,
) -> Result<Vec<String>, redis::RedisError> {
    let indexed: Vec<String> = redis
        .with_conn(async |mut conn| {
            let index_key = index_key.to_string();
            conn.smembers(index_key).await
        })
        .await?;
    let plan = index_members_plan(redis, index_key, indexed).await?;
    if !plan.needs_scan {
        return Ok(plan.existing);
    }

    let scanned = scan_keys_on(redis, pattern).await?;
    if let Some(members) = backfill_index_members(&scanned) {
        let index_key = index_key.to_string();
        let _: i64 = redis
            .with_conn(async |mut conn| {
                redis::cmd("SADD")
                    .arg(index_key)
                    .arg(members)
                    .query_async(&mut conn)
                    .await
            })
            .await?;
    }
    Ok(scanned)
}

async fn indexed_existing_keys_on(
    redis: &Redis,
    index_key: &str,
) -> Result<Vec<String>, redis::RedisError> {
    let indexed: Vec<String> = redis
        .with_conn(async |mut conn| {
            let index_key = index_key.to_string();
            conn.smembers(index_key).await
        })
        .await?;
    index_members_plan(redis, index_key, indexed)
        .await
        .map(|plan| plan.existing)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct IndexedMemberPlan {
    pub(crate) existing: Vec<String>,
    pub(crate) stale: Vec<String>,
    pub(crate) needs_scan: bool,
}

pub(crate) fn classify_index_members(members: Vec<String>, checks: Vec<i64>) -> IndexedMemberPlan {
    let mut existing = Vec::new();
    let mut stale = Vec::new();
    for (member, exists) in members.into_iter().zip(checks) {
        if exists > 0 {
            existing.push(member);
        } else {
            stale.push(member);
        }
    }
    let needs_scan = existing.is_empty();
    IndexedMemberPlan {
        existing,
        stale,
        needs_scan,
    }
}

pub(crate) fn backfill_index_members(scanned: &[String]) -> Option<Vec<String>> {
    if scanned.is_empty() {
        None
    } else {
        Some(scanned.to_vec())
    }
}

async fn index_members_plan(
    redis: &Redis,
    index_key: &str,
    members: Vec<String>,
) -> Result<IndexedMemberPlan, redis::RedisError> {
    if members.is_empty() {
        return Ok(IndexedMemberPlan {
            existing: Vec::new(),
            stale: Vec::new(),
            needs_scan: true,
        });
    }
    let checks: Vec<i64> = redis
        .with_conn(async |mut conn| {
            let members = members.clone();
            let mut pipe = redis::pipe();
            for member in &members {
                pipe.cmd("EXISTS").arg(member);
            }
            pipe.query_async(&mut conn).await
        })
        .await?;
    let plan = classify_index_members(members, checks);
    if !plan.stale.is_empty() {
        // Data writers only add discovery-index entries. Removing them at
        // stream/ZSET drain points can race a concurrent producer; reconcile
        // owns stale cleanup after proving the referenced key is absent.
        let index_key = index_key.to_string();
        let stale = plan.stale.clone();
        let _: i64 = redis
            .with_conn(async |mut conn| {
                redis::cmd("SREM")
                    .arg(index_key)
                    .arg(stale)
                    .query_async(&mut conn)
                    .await
            })
            .await?;
    }
    Ok(plan)
}

pub(crate) async fn indexed_keys(
    state: &AppState,
    index_key: &str,
    pattern: &str,
) -> Result<Vec<String>, redis::RedisError> {
    indexed_keys_on(&state.redis, index_key, pattern).await
}

pub(crate) async fn indexed_keys_after_backfill(
    state: &AppState,
    index_key: &str,
    backfilled_key: &str,
    pattern: &str,
) -> Result<Vec<String>, redis::RedisError> {
    let backfilled: i64 = state
        .redis
        .with_conn(async |mut conn| {
            let backfilled_key = backfilled_key.to_string();
            conn.exists(backfilled_key).await
        })
        .await?;
    if backfilled > 0 {
        // Once the one-time backfill has crossed pre-index data, writers own
        // this projection. Empty means no discovered keys; do not fall back to
        // keyspace SCAN on every reconcile tick.
        return indexed_existing_keys_on(&state.redis, index_key).await;
    }

    let scanned = scan_keys_on(&state.redis, pattern).await?;
    state
        .redis
        .with_conn(async |mut conn| {
            let mut pipe = redis::pipe();
            if !scanned.is_empty() {
                pipe.cmd("SADD").arg(index_key).arg(scanned.clone());
            }
            pipe.cmd("SET").arg(backfilled_key).arg("1");
            pipe.query_async::<()>(&mut conn).await
        })
        .await?;
    Ok(scanned)
}

pub(crate) async fn indexed_data_keys(
    state: &AppState,
    index_key: &str,
    pattern: &str,
) -> Result<Vec<String>, redis::RedisError> {
    indexed_keys_on(&state.data_redis, index_key, pattern).await
}
