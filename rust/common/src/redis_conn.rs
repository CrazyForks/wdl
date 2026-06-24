use redis::aio::ConnectionManager;

#[derive(Clone)]
pub struct RedisConnection {
    conn: ConnectionManager,
}

impl RedisConnection {
    pub fn new(conn: ConnectionManager) -> Self {
        Self { conn }
    }

    pub async fn with_conn<T, F, Fut>(&self, f: F) -> Result<T, redis::RedisError>
    where
        F: FnOnce(ConnectionManager) -> Fut,
        Fut: std::future::Future<Output = Result<T, redis::RedisError>>,
    {
        f(self.conn.clone()).await
    }

    pub fn clone_manager(&self) -> ConnectionManager {
        self.conn.clone()
    }
}
