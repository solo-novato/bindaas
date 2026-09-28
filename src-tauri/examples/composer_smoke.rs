//! Explicit, opt-in real Codex smoke test; uses the configured personal wrapper.
use bindaas::{
    attachments::Store,
    codex::{
        input::{turn_params, Mode},
        Client, Sink,
    },
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

async fn completed(events: &Arc<Mutex<Vec<(String, Value)>>>) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            {
                let events = events.lock().unwrap();
                if events
                    .iter()
                    .any(|(name, _)| name == "codex://approval-requested")
                {
                    return Err("Interactive input requested; inspect in Workbench".into());
                }
                if let Some((_, v)) = events
                    .iter()
                    .find(|(name, _)| name == "codex://turn-completed")
                {
                    return if v["turn"]["status"] == "completed" {
                        Ok(())
                    } else {
                        Err(format!("Turn status: {}", v["turn"]["status"]))
                    };
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "Smoke test timed out".to_string())?
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let project = tempfile::tempdir().map_err(|e| e.to_string())?;
    let snapshots = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut store = Store::new(snapshots.path().join("attachments"));
    let doc = store.import_bytes(
        "brief.txt",
        b"The required token is WORKBENCH_FILE_TOKEN.",
        false,
    )?;
    let image = store.import_bytes(
        "color.png",
        include_bytes!("../../tests/fixtures/red.png"),
        true,
    )?;
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
    let copy = events.clone();
    let sink: Sink = Arc::new(move |name, value| copy.lock().unwrap().push((name.into(), value)));
    let executable = std::env::args()
        .nth(1)
        .ok_or("Pass the Codex executable or wrapper path")?;
    let client = Client::spawn(
        std::path::Path::new(&executable),
        1,
        sink,
        Arc::new(Notify::new()),
    )
    .await?;
    let result = async {
        let thread = client.request("thread/start", json!({"cwd":project.path(),"approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":"workspace-write"})).await?;
        let id = thread["thread"]["id"].as_str().ok_or("Missing thread")?;
        let model = thread["model"].as_str().ok_or("Missing model")?;
        let input = store.input(&[doc.id, image.id])?;
        client.request("turn/start", turn_params(id, "Create a concrete, minimal plan to add result.txt containing the required token from attached brief.txt, one space, and the dominant color of the attached image in lowercase, followed by a newline. State the exact planned contents. Do not implement yet. No questions are needed.", input, Mode::Plan, model, Some("low"))).await?;
        completed(&events).await?;
        if project.path().join("result.txt").exists() { return Err("Plan mode unexpectedly wrote the result file".into()); }
        let plan = events.lock().unwrap().iter().filter(|(_, v)| v["title"] == "Plan").map(|(_, v)| v["text"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>().join("\n");
        if !plan.contains("WORKBENCH_FILE_TOKEN") || !plan.to_lowercase().contains("red") { return Err("No authoritative plan grounded in both attachments".into()); }
        println!("Plan mode verified: authoritative plan used file contents and identified the image color; no result file written.");
        events.lock().unwrap().clear();
        client.request("turn/start", turn_params(id, "Implement that plan now. Write only result.txt with exactly the planned token, one space, the lowercase color, and a newline.", vec![], Mode::Default, model, Some("low"))).await?;
        completed(&events).await?;
        let actual = std::fs::read_to_string(project.path().join("result.txt")).map_err(|e| e.to_string())?;
        if actual != "WORKBENCH_FILE_TOKEN red\n" { return Err("Code mode result did not match both attachments".into()); }
        println!("Code mode verified: same thread implemented the plan with exact attachment-derived contents.");
        Ok(())
    }.await;
    client.stop().await;
    result
}
