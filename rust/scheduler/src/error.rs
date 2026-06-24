#[derive(Debug)]
pub(crate) struct SchedulerError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

pub(crate) type SchedulerResult<T> = Result<T, SchedulerError>;

impl From<redis::RedisError> for SchedulerError {
    fn from(err: redis::RedisError) -> Self {
        Self {
            code: "redis_error",
            message: err.to_string(),
        }
    }
}

impl From<serde_json::Error> for SchedulerError {
    fn from(err: serde_json::Error) -> Self {
        Self {
            code: "internal_json_error",
            message: err.to_string(),
        }
    }
}

impl SchedulerError {
    pub(crate) fn internal_error(message: impl Into<String>) -> Self {
        Self {
            code: "internal_error",
            message: message.into(),
        }
    }
}
