#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(redis_proxy::healthcheck());
    }
    redis_proxy::run().await
}
