//! Opt-in installed-Codex settings check. Ephemeral thread, no model requests.
use bindaas::codex::{
    speed::{apply, Target},
    Client,
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Notify;

#[tokio::test]
#[ignore = "requires CODEX_WORKBENCH_LIVE_EXECUTABLE; changes only an ephemeral test thread"]
async fn installed_codex_confirms_fast_and_standard_without_a_model_turn() {
    let executable = std::env::var("CODEX_WORKBENCH_LIVE_EXECUTABLE").unwrap();
    let root = tempfile::tempdir().unwrap();
    let c = Client::spawn(
        &PathBuf::from(executable),
        1,
        Arc::new(|_, _| {}),
        Arc::new(Notify::new()),
    )
    .await
    .unwrap();
    let result: Result<(), String> = async {
        let v = c.request("thread/start", json!({"cwd":root.path(),"ephemeral":true,"sandbox":"read-only","approvalPolicy":"never"})).await?;
        let id = v["thread"]["id"].as_str().ok_or("Missing thread ID")?.to_owned();
        c.resumed.lock().await.insert(id.clone(),v);
        for fast in [true,false] {
            let targets = vec![Target { thread_id:id.clone(),turn_id:None }];
            let results = apply(c.clone(),root.path(),targets,fast).await?;
            let r = &results[0];
            if r["future"] != "saved" || r["active"] != "notTargeted" {
                return Err(format!("Settings update failed: {}",r["error"].as_str().or_else(||r["futureError"].as_str()).unwrap_or("unconfirmed")));
            }
            let matches = if fast {
                matches!(r["settings"]["serviceTier"].as_str(), Some("fast" | "priority"))
            } else { r["settings"]["serviceTier"].is_null() || r["settings"]["serviceTier"] == "default" };
            if !matches {
                return Err(format!("Requested fast={fast}; Codex reported tier {}", r["settings"]["serviceTier"]));
            }
        }
        println!("Installed Codex confirmed Fast, then cleared the tier. No model turn sent.");
        Ok(())
    }.await;
    c.stop().await;
    result.unwrap();
}
