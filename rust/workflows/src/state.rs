use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Semaphore;
use wdl_rust_common::redis_conn::RedisConnection;
pub(crate) use wdl_rust_common::shutdown::{InFlightGuard, ShutdownState};

use crate::{Config, Metrics};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) redis: Redis,
    pub(crate) control_redis: Redis,
    pub(crate) http: reqwest::Client,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) shutdown: Arc<ShutdownState>,
    pub(crate) progress_callback_lookups: Arc<Semaphore>,
    pub(crate) progress_callbacks: Arc<Semaphore>,
    pub(crate) progress_callback_cache: Arc<Mutex<ProgressCallbackCache>>,
    pub(crate) config: Arc<Config>,
    pub(crate) instance_id: String,
    pub(crate) run_claim_counter: Arc<AtomicU64>,
}

#[derive(Default)]
pub(crate) struct ProgressCallbackCache {
    entries: HashMap<String, Option<String>>,
    order: VecDeque<String>,
}

impl ProgressCallbackCache {
    pub(crate) fn get(&self, key: &str) -> Option<Option<String>> {
        self.entries.get(key).cloned()
    }

    pub(crate) fn insert(&mut self, key: String, value: Option<String>, limit: usize) {
        if !self.entries.contains_key(&key) {
            while self.entries.len() >= limit {
                let Some(oldest) = self.order.pop_front() else {
                    self.entries.clear();
                    break;
                };
                self.entries.remove(&oldest);
            }
            self.order.push_back(key.clone());
        }
        self.entries.insert(key, value);
    }
}

pub(crate) type Redis = RedisConnection;

impl AppState {
    pub(crate) fn next_run_claim_sequence(&self) -> u64 {
        self.run_claim_counter.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn begin_in_flight(&self) -> Option<InFlightGuard> {
        self.shutdown.begin_in_flight()
    }

    pub(crate) async fn request_shutdown(&self) {
        self.shutdown
            .request_shutdown(self.config.shutdown_drain_ms)
            .await;
    }
}
