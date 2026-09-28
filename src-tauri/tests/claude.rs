use bindaas::{
    claude::{self, Client},
    codex::Sink,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
type Events = Arc<Mutex<Vec<(String, Value)>>>;
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/claude-cli.mjs")
}
fn events() -> (Events, Sink) {
    let e: Events = Default::default();
    let target = e.clone();
    (
        e,
        Arc::new(move |n, v| target.lock().unwrap().push((n.into(), v))),
    )
}
async fn event(e: &Events, name: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some((_, v)) = e.lock().unwrap().iter().rev().find(|(n, _)| n == name) {
                return v.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect(name)
}
async fn client(root: &std::path::Path, generation: u64, sink: Sink) -> Arc<Client> {
    Client::spawn(
        &fixture(),
        root,
        &claude::uuid(),
        false,
        generation,
        sink,
        5,
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn stream_tools_completion_and_native_permissions() {
    let dir = tempfile::tempdir().unwrap();
    let (e, sink) = events();
    let c = client(dir.path(), 1, sink).await;
    let response = c
        .start("hello", vec![], None, Some("default"))
        .await
        .unwrap();
    let done = event(&e, "agent://turn-completed").await;
    assert_eq!(done["turn"]["status"], "completed");
    assert_eq!(done["turn"]["id"], response["turn"]["id"]);
    assert_eq!(done["turn"]["settings"]["approvalPolicy"], "acceptEdits");
    assert!(!e
        .lock()
        .unwrap()
        .iter()
        .any(|(_, v)| v.to_string().contains("NEVER SHOW")));
    let r = c.runtime.lock().await;
    let tool = r.items.iter().find(|i| i["kind"] == "command").unwrap();
    assert_eq!(tool["output"], "PASS fixture");
    assert!(tool["exitCode"].is_null());
    assert_eq!(r.items.iter().filter(|i| i["kind"] == "message").count(), 1);
    drop(r);
    c.shutdown(false).await.unwrap();
}
#[tokio::test]
async fn approvals_are_scoped_to_session_and_generation_and_resolve_once() {
    let dir = tempfile::tempdir().unwrap();
    let (e, sink) = events();
    let a = client(dir.path(), 7, sink.clone()).await;
    let b = client(dir.path(), 8, sink).await;
    a.start("approval", vec![], None, None).await.unwrap();
    let request = event(&e, "agent://approval-requested").await;
    let id = request["requestId"].as_str().unwrap();
    assert!(request.get("nativeInput").is_none());
    assert!(a.respond(6, id, &json!("accept"), None).await.is_err());
    assert!(b.respond(8, id, &json!("accept"), None).await.is_err());
    assert!(a.shutdown(false).await.is_err());
    a.respond(7, id, &json!("accept"), None).await.unwrap();
    assert!(a.respond(7, id, &json!("accept"), None).await.is_err());
    event(&e, "agent://turn-completed").await;
    a.shutdown(false).await.unwrap();
    b.shutdown(false).await.unwrap();
}
#[tokio::test]
async fn multi_select_questions_round_trip_as_native_answers() {
    let dir = tempfile::tempdir().unwrap();
    let (e, sink) = events();
    let c = client(dir.path(), 1, sink).await;
    c.start("question", vec![], None, None).await.unwrap();
    let q = event(&e, "agent://approval-requested").await;
    assert_eq!(q["questions"][0]["multiSelect"], true);
    c.respond(
        1,
        q["requestId"].as_str().unwrap(),
        &Value::Null,
        Some(json!({"0":["Unit","Integration"]})),
    )
    .await
    .unwrap();
    assert_eq!(
        event(&e, "agent://turn-completed").await["turn"]["status"],
        "completed"
    );
    c.shutdown(false).await.unwrap();
}
#[tokio::test]
async fn concurrent_sessions_interrupt_and_crash_are_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let (ea, sa) = events();
    let (eb, sb) = events();
    let a = client(dir.path(), 1, sa).await;
    let b = client(dir.path(), 2, sb).await;
    let ar = a.start("hold", vec![], None, None).await.unwrap();
    b.start("crash", vec![], None, None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if !b.alive.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        b.runtime.lock().await.turn.as_ref().unwrap()["status"],
        "connectionLost"
    );
    assert_eq!(
        a.runtime.lock().await.turn.as_ref().unwrap()["status"],
        "inProgress"
    );
    assert!(a.interrupt("wrong-turn").await.is_err());
    a.interrupt(ar["turn"]["id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        event(&ea, "agent://turn-completed").await["turn"]["status"],
        "interrupted"
    );
    assert!(eb
        .lock()
        .unwrap()
        .iter()
        .any(|(n, v)| n == "agent://connection" && v["type"] == "disconnected"));
    a.shutdown(false).await.unwrap();
}
#[tokio::test]
async fn idle_releases_process_and_probe_exposes_no_identity() {
    let p = claude::probe(&fixture()).await.unwrap();
    assert_eq!(p["authenticated"], true);
    assert!(!p.to_string().contains("must-not-leak"));
    let dir = tempfile::tempdir().unwrap();
    let (_, sink) = events();
    let c = client(dir.path(), 1, sink).await;
    tokio::time::timeout(Duration::from_secs(9), async {
        loop {
            if !c.alive.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert!(c.start("hello", vec![], None, None).await.is_err());
}
#[tokio::test]
#[ignore = "requires installed Claude CLI and native authentication; optional CLAUDE_WORKBENCH_LIVE_TURN=1 sends a disposable smoke prompt"]
async fn installed_claude_protocol_and_disposable_turn() {
    let exe = claude::discover(None).unwrap();
    let probe = claude::probe(&exe).await.unwrap();
    assert_eq!(
        probe["authenticated"], true,
        "Native Claude authentication is required"
    );
    let dir = tempfile::tempdir().unwrap();
    let (e, sink) = events();
    let root = dir.path().canonicalize().unwrap();
    let c = Client::spawn(&exe, &root, &claude::uuid(), false, 1, sink.clone(), 30)
        .await
        .unwrap();
    let result: Result<(), String> = async {
        assert!(c.initialization.lock().await.is_object());
        if std::env::var("CLAUDE_WORKBENCH_LIVE_TURN").as_deref() == Ok("1") {
            c.start(
                "Reply with exactly WORKBENCH_OK. Do not call tools or read files.",
                vec![],
                None,
                None,
            )
            .await?;
            tokio::time::timeout(Duration::from_secs(90), async {
                loop {
                    if e.lock()
                        .unwrap()
                        .iter()
                        .any(|(n, _)| n == "agent://turn-completed")
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .map_err(|_| "Live turn timed out")?;
            let r = c.runtime.lock().await;
            if r.turn.as_ref().unwrap()["status"] != "completed" {
                return Err(format!(
                    "Live turn failed: {}",
                    r.turn.as_ref().unwrap()["error"]
                ));
            }
            if !r.items.iter().any(|i| {
                i["text"]
                    .as_str()
                    .is_some_and(|t| t.contains("WORKBENCH_OK"))
            }) {
                return Err("Missing smoke response".into());
            }
        }
        Ok(())
    }
    .await;
    c.shutdown(true).await.unwrap();
    result.unwrap();
    if std::env::var("CLAUDE_WORKBENCH_LIVE_TURN").as_deref() == Ok("1") {
        let (_, turns) =
            claude::history::read(&claude::history::config_dir(), &root, &c.id).unwrap();
        assert!(turns
            .iter()
            .any(|t| t["items"].as_array().unwrap().iter().any(|i| i["text"]
                .as_str()
                .is_some_and(|s| s.contains("WORKBENCH_OK")))));
        e.lock().unwrap().clear();
        let resumed = Client::spawn(&exe, &root, &c.id, true, 2, sink, 30)
            .await
            .unwrap();
        let result: Result<(), String> = async {
            resumed
                .start(
                    "Reply with exactly RESUME_OK. Do not call tools or read files.",
                    vec![],
                    None,
                    None,
                )
                .await?;
            tokio::time::timeout(Duration::from_secs(90), async {
                loop {
                    if e.lock()
                        .unwrap()
                        .iter()
                        .any(|(n, _)| n == "agent://turn-completed")
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .map_err(|_| "Resumed turn timed out")?;
            if resumed.runtime.lock().await.turn.as_ref().unwrap()["status"] != "completed" {
                return Err("Resumed native turn failed".into());
            }
            Ok(())
        }
        .await;
        resumed.shutdown(true).await.unwrap();
        result.unwrap();
    }
}

#[tokio::test]
async fn background_work_keeps_turn_active_until_observed_completion() {
    let dir = tempfile::tempdir().unwrap();
    let (e, sink) = events();
    let c = client(dir.path(), 1, sink).await;
    c.start("background", vec![], None, None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        c.runtime.lock().await.turn.as_ref().unwrap()["status"],
        "inProgress"
    );
    assert!(c.shutdown(false).await.is_err());
    let done = event(&e, "agent://turn-completed").await;
    assert_eq!(done["turn"]["status"], "completed");
    assert!(c
        .runtime
        .lock()
        .await
        .items
        .iter()
        .any(|i| i["id"] == "background:task-1" && i["status"] == "completed"));
    c.shutdown(false).await.unwrap();
}
