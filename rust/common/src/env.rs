use std::env;
use std::str::FromStr;

pub fn positive_or<T>(raw: Option<String>, fallback: T) -> T
where
    T: Copy + From<u8> + FromStr + PartialOrd,
{
    raw.and_then(|value| value.parse::<T>().ok())
        .filter(|value| *value > T::from(0))
        .unwrap_or(fallback)
}

pub fn env_positive<T>(name: &str, fallback: T) -> T
where
    T: Copy + From<u8> + FromStr + PartialOrd,
{
    positive_or(env::var(name).ok(), fallback)
}

pub fn env_u16(name: &str, fallback: u16) -> u16 {
    env_positive(name, fallback)
}

pub fn env_u64(name: &str, fallback: u64) -> u64 {
    env_positive(name, fallback)
}

pub fn env_usize(name: &str, fallback: usize) -> usize {
    env_positive(name, fallback)
}

pub fn optional_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positive_or_accepts_only_positive_values() {
        assert_eq!(positive_or::<u16>(Some("42".to_string()), 7), 42);
        assert_eq!(positive_or::<u64>(Some("0".to_string()), 7), 7);
        assert_eq!(positive_or::<i64>(Some("-1".to_string()), 7), 7);
        assert_eq!(positive_or::<usize>(Some("-1".to_string()), 7), 7);
        assert_eq!(positive_or::<usize>(Some(String::new()), 7), 7);
        assert_eq!(positive_or::<usize>(Some("nope".to_string()), 7), 7);
        assert_eq!(positive_or::<usize>(Some("12.9".to_string()), 7), 7);
        assert_eq!(positive_or::<usize>(Some("1e3".to_string()), 7), 7);
        assert_eq!(
            positive_or::<u64>(Some("18446744073709551616".to_string()), 7),
            7
        );
        assert_eq!(positive_or::<usize>(None, 7), 7);
    }
}
