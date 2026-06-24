use redis::FromRedisValue;
use wdl_rust_common::redis_eval::eval_cmd;

use crate::{AppState, WorkflowResult};

pub(crate) async fn eval_script<T>(
    app: &AppState,
    script: &str,
    keys: &[&str],
    args: &[&str],
) -> WorkflowResult<T>
where
    T: FromRedisValue,
{
    app.redis
        .with_conn(async |mut conn| {
            let cmd = eval_cmd(script, keys, args);
            cmd.query_async(&mut conn).await
        })
        .await
        .map_err(Into::into)
}
