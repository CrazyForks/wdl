//! Queue Redis key helpers shared by producer and scheduler services.

use crate::identity::is_valid_runtime_load_ns;

pub const QUEUE_CONSUMER_INDEX_KEY: &str = "queue:index:consumers";
pub const QUEUE_STREAM_INDEX_KEY: &str = "queue:index:streams";
pub const QUEUE_DELAYED_INDEX_KEY: &str = "queue:index:delayed";

pub fn is_valid_queue_name(queue: &str) -> bool {
    let bytes = queue.as_bytes();
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

pub fn queue_stream_key(ns: &str, queue: &str) -> String {
    format!("queue:{ns}:{queue}:s")
}

pub fn queue_delayed_key(ns: &str, queue: &str) -> String {
    format!("queue-delayed:{ns}:{queue}")
}

pub fn queue_dlq_key(ns: &str, queue: &str) -> String {
    format!("queue:{ns}:{queue}:dlq")
}

pub fn queue_orphaned_key(ns: &str, queue: &str) -> String {
    format!("queue-orphaned:{ns}:{queue}")
}

pub fn queue_consumer_key(ns: &str, queue: &str) -> String {
    format!("queue-consumer:{ns}:{queue}")
}

pub fn parse_stream_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("queue:")?;
    let rest = rest.strip_suffix(":s")?;
    split_queue_key_rest(rest)
}

pub fn parse_delayed_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("queue-delayed:")?;
    split_queue_key_rest(rest)
}

pub fn parse_consumer_key(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("queue-consumer:")?;
    split_queue_key_rest(rest)
}

fn split_queue_key_rest(rest: &str) -> Option<(String, String)> {
    let (ns, queue) = rest.split_once(':')?;
    if !is_valid_runtime_load_ns(ns) || !is_valid_queue_name(queue) {
        return None;
    }
    Some((ns.to_string(), queue.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_fixtures::identity_cases;

    #[test]
    fn queue_name_grammar_matches_cross_language_fixture() {
        for (value, valid) in identity_cases("queueNames") {
            assert_eq!(is_valid_queue_name(&value), valid, "queueNames:{value:?}");
        }
    }

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
    fn queue_name_grammar_matches_control_contract() {
        assert!(is_valid_queue_name("jobs"));
        assert!(is_valid_queue_name("jobs-1"));
        assert!(is_valid_queue_name(&"a".repeat(63)));
        for queue in ["", "Jobs", "-jobs", "jobs_", "jobs:tail"] {
            assert!(!is_valid_queue_name(queue), "{queue}");
        }
        assert!(!is_valid_queue_name(&"a".repeat(64)));
    }

    #[test]
    fn parse_queue_keys() {
        assert_eq!(
            parse_stream_key("queue:demo:jobs:s"),
            Some(("demo".to_string(), "jobs".to_string()))
        );
        assert_eq!(
            parse_stream_key("queue:__platform__:jobs:s"),
            Some(("__platform__".to_string(), "jobs".to_string()))
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
        assert_eq!(parse_stream_key("queue:admin:jobs:s"), None);
        assert_eq!(parse_stream_key("queue:__community__:jobs:s"), None);
        assert_eq!(parse_stream_key("queue:demo:Jobs:s"), None);
        assert_eq!(parse_stream_key("queue:demo:jobs:extra:s"), None);
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
