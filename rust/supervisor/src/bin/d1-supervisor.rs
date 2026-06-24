#[tokio::main(flavor = "current_thread")]
async fn main() {
    supervisor::run_d1().await
}
