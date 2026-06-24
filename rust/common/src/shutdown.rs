use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

#[derive(Default)]
pub struct ShutdownState {
    stopping: AtomicBool,
    in_flight: AtomicUsize,
    idle: Notify,
    stop: Notify,
}

pub struct InFlightGuard {
    shutdown: Arc<ShutdownState>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        if self.shutdown.in_flight.fetch_sub(1, Ordering::SeqCst) == 1 {
            // notify_one stores a permit when no listener is registered yet,
            // so request_shutdown's notified().await cannot miss the last drop.
            self.shutdown.idle.notify_one();
        }
    }
}

impl ShutdownState {
    pub fn begin_in_flight(self: &Arc<Self>) -> Option<InFlightGuard> {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let guard = InFlightGuard {
            shutdown: self.clone(),
        };
        if self.stopping.load(Ordering::SeqCst) {
            drop(guard);
            return None;
        }
        Some(guard)
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    pub fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    pub fn begin_shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop.notify_waiters();
    }

    pub fn stop_notified(&self) -> impl Future<Output = ()> + '_ {
        self.stop.notified()
    }

    pub async fn request_shutdown(&self, drain_ms: u64) {
        self.begin_shutdown();
        let wait = async {
            loop {
                if self.in_flight_count() == 0 {
                    break;
                }
                self.idle.notified().await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(drain_ms), wait).await;
    }
}

pub async fn shutdown_signal() -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        let mut sigterm =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = sigterm.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_flight_guard_releases_when_holder_drops_normally() {
        let shutdown = Arc::new(ShutdownState::default());
        let guard = shutdown.begin_in_flight().expect("guard should start");
        assert_eq!(shutdown.in_flight_count(), 1);
        drop(guard);
        assert_eq!(shutdown.in_flight_count(), 0);
    }

    #[test]
    fn begin_in_flight_rejects_after_shutdown_without_leaking_count() {
        let shutdown = Arc::new(ShutdownState::default());
        shutdown.begin_shutdown();
        assert!(shutdown.begin_in_flight().is_none());
        assert_eq!(shutdown.in_flight_count(), 0);
    }

    #[tokio::test]
    async fn in_flight_guard_releases_when_holder_panics_inside_spawn() {
        let shutdown = Arc::new(ShutdownState::default());
        let guard = shutdown.begin_in_flight().expect("guard should start");
        assert_eq!(shutdown.in_flight_count(), 1);

        let join = tokio::spawn(async move {
            let _guard = guard;
            panic!("simulated dispatcher panic");
        });
        let result = join.await;
        assert!(
            result.as_ref().is_err_and(|err| err.is_panic()),
            "spawn must surface the panic as JoinError"
        );
        assert_eq!(
            shutdown.in_flight_count(),
            0,
            "InFlightGuard must release in_flight even when the holder panics"
        );
    }
}
