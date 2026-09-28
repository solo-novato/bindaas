use bindaas::codex::{
    speed::{apply, Target},
    Client,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Notify;

async fn client() -> Arc<Client> {
    Client::spawn(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/speed-app-server.mjs"),
        7,
        Arc::new(|_, _| {}),
        Arc::new(Notify::new()),
    )
    .await
    .unwrap()
}
async fn start(c: &Client, root: &Path, options: Value) -> Target {
    let mut params = options;
    params["cwd"] = json!(root);
    let v = c.request("thread/start", params).await.unwrap();
    let id = v["thread"]["id"].as_str().unwrap().to_owned();
    let turn = c
        .request("turn/start", json!({"threadId":id,"input":[]}))
        .await
        .unwrap();
    Target {
        thread_id: id,
        turn_id: Some(turn["turn"]["id"].as_str().unwrap().into()),
    }
}

#[tokio::test]
async fn fast_updates_four_exact_turns_and_future_settings_without_interrupting() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    let mut targets = vec![];
    for _ in 0..4 {
        targets.push(start(&c, root.path(), json!({})).await);
    }
    let active = c.active.lock().await.clone();
    let results = apply(c.clone(), root.path(), targets.clone(), true)
        .await
        .unwrap();
    assert_eq!(results.len(), 4);
    for result in &results {
        assert_eq!(result["future"], "saved");
        assert_eq!(result["active"], "applied");
        assert_eq!(result["settings"]["serviceTier"], "priority");
        assert_eq!(result["settings"]["model"], "fixture");
        assert_eq!(result["settings"]["mode"], "plan");
        assert_eq!(result["settings"]["effort"], "high");
        assert_eq!(result["settings"]["approvalPolicy"], "on-request");
    }
    assert_eq!(*c.active.lock().await, active);
    let state = c
        .request("thread/read", json!({"threadId":targets[0].thread_id}))
        .await
        .unwrap();
    let requests = state["requests"].as_array().unwrap();
    assert!(!requests.iter().any(|r| matches!(
        r["method"].as_str(),
        Some("turn/interrupt" | "thread/resume")
    )));
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "turn/start")
            .count(),
        4
    );
    for target in targets {
        assert!(requests
            .iter()
            .any(|r| r["method"] == "turn/settings/update"
                && r["params"]
                    == json!({
            "threadId":target.thread_id,"turnId":target.turn_id,"serviceTier":"fast"})));
    }
    c.stop().await;
}

#[tokio::test]
async fn partial_failures_and_finished_turns_are_reported_separately() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    let a = start(&c, root.path(), json!({"failActive":true})).await;
    let b = start(&c, root.path(), json!({"failFuture":true})).await;
    let d = start(&c, root.path(), json!({"finishDuringUpdate":true})).await;
    let mut stale = start(&c, root.path(), json!({})).await;
    stale.turn_id = Some("old-turn".into());
    let results = apply(c.clone(), root.path(), vec![a, b, d, stale], true)
        .await
        .unwrap();
    assert_eq!(results[0]["future"], "saved");
    assert_eq!(results[0]["active"], "failed");
    assert!(results[0]["activeError"]
        .as_str()
        .unwrap()
        .contains("unsupported"));
    assert_eq!(results[1]["future"], "failed");
    assert_eq!(results[1]["active"], "applied");
    assert_eq!(results[2]["active"], "targetUnavailable");
    assert_eq!(results[3]["active"], "targetUnavailable");
    let state = c
        .request("thread/read", json!({"threadId":"thread-3"}))
        .await
        .unwrap();
    assert!(!state["requests"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "turn/settings/update" && r["params"]["turnId"] == "old-turn"));
    c.stop().await;
}

#[tokio::test]
async fn standard_clears_tier_and_project_and_target_validation_precede_writes() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let c = client().await;
    let target = start(&c, root.path(), json!({})).await;
    assert!(apply(
        c.clone(),
        root.path(),
        vec![target.clone(), target.clone()],
        true
    )
    .await
    .is_err());
    let denied = apply(c.clone(), other.path(), vec![target.clone()], true)
        .await
        .unwrap();
    assert_eq!(denied[0]["error"], "Thread belongs to another project");
    let before = c
        .request("thread/read", json!({"threadId":target.thread_id}))
        .await
        .unwrap();
    assert!(!before["requests"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "thread/settings/update"));
    let results = apply(c.clone(), root.path(), vec![target], false)
        .await
        .unwrap();
    assert_eq!(results[0]["active"], "applied");
    assert_eq!(results[0]["settings"]["serviceTier"], "default");
    c.stop().await;
}
