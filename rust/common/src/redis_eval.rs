//! Redis Lua command construction helpers.
//!
//! These helpers intentionally only build commands. Service crates still own
//! connection management, error mapping, script bodies, and key ownership.

pub fn eval_cmd(script: &str, keys: &[&str], args: &[&str]) -> redis::Cmd {
    let mut cmd = redis::cmd("EVAL");
    cmd.arg(script).arg(keys.len());
    for key in keys {
        cmd.arg(*key);
    }
    for arg in args {
        cmd.arg(*arg);
    }
    cmd
}

pub fn append_eval_cmd(pipe: &mut redis::Pipeline, script: &str, keys: &[&str], args: &[&str]) {
    pipe.cmd("EVAL").arg(script).arg(keys.len());
    for key in keys {
        pipe.arg(*key);
    }
    for arg in args {
        pipe.arg(*arg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eval_cmd_derives_numkeys_from_key_slice() {
        let actual = eval_cmd("return KEYS[1]", &["k1", "k2"], &["a1"]).get_packed_command();
        let expected = redis::cmd("EVAL")
            .arg("return KEYS[1]")
            .arg(2)
            .arg("k1")
            .arg("k2")
            .arg("a1")
            .get_packed_command();
        assert_eq!(actual, expected);
    }

    #[test]
    fn append_eval_cmd_derives_numkeys_from_key_slice() {
        let mut actual = redis::pipe();
        append_eval_cmd(&mut actual, "return KEYS[1]", &["k1", "k2"], &["a1"]);

        let mut expected = redis::pipe();
        expected
            .cmd("EVAL")
            .arg("return KEYS[1]")
            .arg(2)
            .arg("k1")
            .arg("k2")
            .arg("a1");
        assert_eq!(actual.get_packed_pipeline(), expected.get_packed_pipeline());
    }
}
