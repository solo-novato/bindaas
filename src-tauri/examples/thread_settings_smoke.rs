//! Metadata-only smoke test. Run with an isolated CODEX_HOME containing a test rollout.
//! No turn is sent and no model is called.
use bindaas::codex::{Client, Sink};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Notify;
#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || std::env::var("WORKBENCH_ISOLATED_SETTINGS_SMOKE").as_deref() != Ok("1") {
        return Err("Requires isolated CODEX_HOME and arguments: codex thread-id project".into());
    }
    let executable = PathBuf::from(&args[1]);
    let id = &args[2];
    let root = PathBuf::from(&args[3]);
    for (generation, expected_mode, expected_effort) in [
        (1, "plan", "high"),
        (2, "default", "low"),
        (3, "plan", "high"),
    ] {
        let sink: Sink = Arc::new(|_, _| {});
        let c = Client::spawn(&executable, generation, sink, Arc::new(Notify::new())).await?;
        let result: Result<(), String> = async {
            let current = c.request("thread/read", json!({"threadId":id,"includeTurns":false})).await?;
            let response = c.resume_or_attach(id, &root, current).await?;
            let settings = c.effective_settings(id, &response).await;
            if settings["mode"] != expected_mode || settings["effort"] != expected_effort {
                return Err(format!("Unexpected metadata: mode={}, effort={}", settings["mode"], settings["effort"]));
            }
            if generation > 1 && (settings["permissionProfile"]["id"] != ":read-only" || settings["approvalPolicy"] != "untrusted") {
                return Err(format!("Permissions not recovered: profile={}, policy={}",settings["permissionProfile"],settings["approvalPolicy"]));
            }
            println!("Process {generation}: Codex reports {expected_mode}, {expected_effort}; model={}", settings["model"]);
            if generation < 3 {
                let (mode, effort) = if generation == 1 { ("default", "low") } else { ("plan", "high") };
                c.update_settings(json!({"threadId":id,"permissions":":read-only","approvalPolicy":"untrusted","collaborationMode":{"mode":mode,"settings":{"model":settings["model"],"reasoning_effort":effort,"developer_instructions":Value::Null}}})).await?;
            }
            Ok(())
        }.await;
        c.stop().await;
        result?;
    }
    Ok(())
}
