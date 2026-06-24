pub(crate) use wdl_rust_common::queue_keys::{
    QUEUE_CONSUMER_INDEX_KEY, QUEUE_DELAYED_INDEX_KEY, QUEUE_STREAM_INDEX_KEY, parse_consumer_key,
    parse_delayed_key, parse_stream_key, queue_consumer_key, queue_delayed_key, queue_dlq_key,
    queue_orphaned_key, queue_stream_key,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_key_builders_compose_redis_key_shapes() {
        assert_eq!(QUEUE_CONSUMER_INDEX_KEY, "queue:index:consumers");
        assert_eq!(QUEUE_STREAM_INDEX_KEY, "queue:index:streams");
        assert_eq!(QUEUE_DELAYED_INDEX_KEY, "queue:index:delayed");
        assert_eq!(queue_stream_key("demo", "jobs"), "queue:demo:jobs:s");
        assert_eq!(queue_delayed_key("demo", "jobs"), "queue-delayed:demo:jobs");
        assert_eq!(queue_dlq_key("demo", "jobs"), "queue:demo:jobs:dlq");
        assert_eq!(
            queue_orphaned_key("demo", "jobs"),
            "queue-orphaned:demo:jobs"
        );
        assert_eq!(
            queue_consumer_key("demo", "jobs"),
            "queue-consumer:demo:jobs"
        );
        assert_eq!(queue_stream_key("t", "my-queue-1"), "queue:t:my-queue-1:s");
    }

    #[test]
    fn parse_queue_keys() {
        assert_eq!(
            parse_stream_key("queue:demo:jobs:s"),
            Some(("demo".to_string(), "jobs".to_string()))
        );
        assert_eq!(
            parse_delayed_key("queue-delayed:demo:jobs"),
            Some(("demo".to_string(), "jobs".to_string()))
        );
        assert_eq!(
            parse_consumer_key("queue-consumer:demo:jobs"),
            Some(("demo".to_string(), "jobs".to_string()))
        );
        assert_eq!(
            parse_stream_key("queue:t:my-queue-1:s"),
            Some(("t".to_string(), "my-queue-1".to_string()))
        );
        assert_eq!(parse_stream_key("queue:demo:jobs"), None);
        assert_eq!(parse_stream_key("queue-delayed:demo:jobs"), None);
        assert_eq!(parse_stream_key("queue::jobs:s"), None);
        assert_eq!(parse_stream_key("notaqueue:demo:jobs:s"), None);
        assert_eq!(parse_stream_key(""), None);
        assert_eq!(parse_delayed_key("queue:demo:jobs:s"), None);
        assert_eq!(parse_delayed_key("queue-delayed::jobs"), None);
        assert_eq!(parse_delayed_key("queue-delayed:demo:"), None);
        assert_eq!(parse_consumer_key("queue-consumer:demo"), None);
        assert_eq!(parse_consumer_key("queue-consumer:"), None);
        assert_eq!(parse_consumer_key("other:demo:jobs"), None);
    }
}
