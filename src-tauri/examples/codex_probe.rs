use bindaas::codex::{discover, Client, Sink};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::Notify;
#[tokio::main]
async fn main() -> Result<(), String> {
    let sink: Sink = Arc::new(|name, _| {
        if name == "codex://connection" {
            println!("connection transition observed");
        }
    });
    let client = Client::spawn(&discover(None)?, 1, sink, Arc::new(Notify::new())).await?;
    let result = async {
        let models = client.request("model/list", json!({"limit":100})).await?;
        println!(
            "model/list succeeded: {} models",
            models["data"].as_array().map(Vec::len).unwrap_or(0)
        );
        let account = client
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        println!(
            "account/read succeeded: signed in = {}",
            !account["account"].is_null()
        );
        Ok(())
    }
    .await;
    client.stop().await;
    result
}
