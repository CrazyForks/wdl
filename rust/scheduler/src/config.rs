use std::env;

use wdl_rust_common::env::{env_u16, env_u64, env_usize, optional_env};
use wdl_rust_common::internal_auth::internal_auth_token_from_env;
use wdl_rust_common::log::{LogLevel, log_level_from_env};

const QUEUE_PEL_IDLE_SAFETY_MS: u64 = 5_000;

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) redis_url: String,
    pub(crate) data_redis_url: String,
    pub(crate) runtime_host: String,
    pub(crate) runtime_port: u16,
    pub(crate) system_runtime_host: String,
    pub(crate) system_runtime_port: u16,
    pub(crate) workflows_host: Option<String>,
    pub(crate) workflows_port: u16,
    pub(crate) workflows_tick_interval_ms: u64,
    pub(crate) workflows_tick_active_interval_ms: u64,
    pub(crate) metrics_port: u16,
    pub(crate) fire_timeout_ms: u64,
    pub(crate) lease_ttl_s: u64,
    pub(crate) sweep_ms: u64,
    pub(crate) queue_reconcile_ms: u64,
    pub(crate) queue_block_ms: u64,
    pub(crate) queue_pel_reap_ms: u64,
    pub(crate) queue_pel_idle_ms: u64,
    pub(crate) queue_sweep_batch_size: usize,
    pub(crate) max_dlq_len: usize,
    pub(crate) max_orphaned_len: usize,
    pub(crate) shutdown_drain_ms: u64,
    pub(crate) max_concurrency: usize,
    pub(crate) cron_max_concurrency: usize,
    pub(crate) queue_max_concurrency: usize,
    pub(crate) internal_auth_token: String,
    pub(crate) log_level: LogLevel,
}

pub(crate) fn config_from_env() -> Config {
    let runtime_host = env::var("RUNTIME_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let runtime_port = env_u16("RUNTIME_PORT", 8088);
    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string());
    let max_concurrency = env_usize("SCHEDULER_MAX_CONCURRENCY", 128);
    let fire_timeout_ms = env_u64("SCHEDULER_FIRE_TIMEOUT_MS", 60_000);
    let queue_pel_idle_ms =
        queue_pel_idle_ms(fire_timeout_ms, env_u64("QUEUE_PEL_IDLE_MS", 60_000));
    Config {
        data_redis_url: env::var("DATA_REDIS_URL").unwrap_or_else(|_| redis_url.clone()),
        redis_url,
        system_runtime_host: env::var("SYSTEM_RUNTIME_HOST")
            .unwrap_or_else(|_| runtime_host.clone()),
        system_runtime_port: env_u16("SYSTEM_RUNTIME_PORT", runtime_port),
        workflows_host: optional_env("WORKFLOWS_HOST"),
        workflows_port: env_u16("WORKFLOWS_PORT", 9120),
        workflows_tick_interval_ms: env_u64("WORKFLOWS_TICK_INTERVAL_MS", 1_000),
        workflows_tick_active_interval_ms: env_u64("WORKFLOWS_TICK_ACTIVE_INTERVAL_MS", 100),
        runtime_host,
        runtime_port,
        metrics_port: env_u16("SCHEDULER_METRICS_PORT", 9110),
        fire_timeout_ms,
        lease_ttl_s: env_u64("SCHEDULER_LEASE_TTL_S", 90),
        sweep_ms: env_u64("SCHEDULER_SWEEP_MS", 5 * 60_000),
        queue_reconcile_ms: env_u64("QUEUE_RECONCILE_MS", 1_500),
        queue_block_ms: env_u64("QUEUE_BLOCK_MS", 2_000),
        queue_pel_reap_ms: env_u64(
            "QUEUE_PEL_REAP_MS",
            env_u64("SCHEDULER_SWEEP_MS", 5 * 60_000),
        ),
        queue_pel_idle_ms,
        queue_sweep_batch_size: env_usize("QUEUE_SWEEP_BATCH_SIZE", 100),
        max_dlq_len: env_usize("SCHEDULER_MAX_DLQ_LEN", 10_000),
        max_orphaned_len: env_usize("SCHEDULER_MAX_ORPHANED_LEN", 10_000),
        // 5s headroom under ECS's default 30s stopTimeout before SIGKILL.
        shutdown_drain_ms: env_u64("SCHEDULER_SHUTDOWN_DRAIN_MS", 25_000),
        max_concurrency,
        cron_max_concurrency: env_usize("SCHEDULER_CRON_MAX_CONCURRENCY", max_concurrency),
        queue_max_concurrency: env_usize("SCHEDULER_QUEUE_MAX_CONCURRENCY", max_concurrency),
        internal_auth_token: internal_auth_token_from_env()
            .expect("WDL_INTERNAL_AUTH_TOKEN must be configured"),
        log_level: log_level_from_env(),
    }
}

fn queue_pel_idle_ms(fire_timeout_ms: u64, configured_idle_ms: u64) -> u64 {
    let minimum_idle_ms = fire_timeout_ms.saturating_add(QUEUE_PEL_IDLE_SAFETY_MS);
    configured_idle_ms.max(minimum_idle_ms)
}

#[cfg(test)]
mod tests {
    use super::{QUEUE_PEL_IDLE_SAFETY_MS, queue_pel_idle_ms};

    #[test]
    fn queue_pel_idle_default_has_fire_timeout_margin() {
        let fire_timeout_ms = 60_000;

        let idle_ms = queue_pel_idle_ms(fire_timeout_ms, 60_000);

        assert_eq!(idle_ms, fire_timeout_ms + QUEUE_PEL_IDLE_SAFETY_MS);
    }

    #[test]
    fn queue_pel_idle_preserves_operator_value_above_margin() {
        let idle_ms = queue_pel_idle_ms(60_000, 90_000);

        assert_eq!(idle_ms, 90_000);
    }

    #[test]
    fn queue_pel_idle_clamps_operator_value_without_margin() {
        let fire_timeout_ms = 120_000;

        let idle_ms = queue_pel_idle_ms(fire_timeout_ms, 121_000);

        assert_eq!(idle_ms, fire_timeout_ms + QUEUE_PEL_IDLE_SAFETY_MS);
    }
}
