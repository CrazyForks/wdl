pub(crate) use wdl_rust_common::time::{now_ms, random_hex_64};

pub(crate) fn random_instance_id() -> String {
    random_hex_64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_instance_id_is_16_hex_chars() {
        let id = random_instance_id();
        assert_eq!(id.len(), 16, "instance id must be 16 hex chars (64 bits)");
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit()),
            "instance id must be lowercase hex: {id}"
        );
    }
}
