#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("healthcheck") => std::process::exit(workflows::healthcheck()),
        Some(arg) => {
            return Err(std::io::Error::other(format!("unknown workflows command `{arg}`")).into());
        }
        None => {}
    }
    workflows::run().await
}
