use bindaas::codex::{
    conversations::{manage, steer},
    Client,
};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::Notify;
async fn client() -> Arc<Client> {
    Client::spawn(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/conversation-app-server.mjs"),
        1,
        Arc::new(|_, _| {}),
        Arc::new(Notify::new()),
    )
    .await
    .unwrap()
}
#[tokio::test]
async fn rename_archive_restore_validate_project_and_preserve_active_work() {
    let root = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let c = client().await;
    let t = c
        .request("thread/start", json!({"cwd":root.path()}))
        .await
        .unwrap();
    let id = t["thread"]["id"].as_str().unwrap();
    assert!(manage(&c, other.path(), id, "archive", None).await.is_err());
    assert!(manage(&c, root.path(), id, "rename", Some("   "))
        .await
        .is_err());
    manage(&c, root.path(), id, "rename", Some("  New name  "))
        .await
        .unwrap();
    manage(&c, root.path(), id, "archive", None).await.unwrap();
    let restored = manage(&c, root.path(), id, "restore", None).await.unwrap();
    assert_eq!(restored["thread"]["name"], "New name");
    assert_eq!(restored["thread"]["archived"], false);
    c.request("turn/start", json!({"threadId":id}))
        .await
        .unwrap();
    assert!(manage(&c, root.path(), id, "archive", None).await.is_err());
    let read = c
        .request("thread/read", json!({"threadId":id}))
        .await
        .unwrap();
    let writes: Vec<_> = read["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["method"] == "thread/archive")
        .collect();
    assert_eq!(writes.len(), 1);
    assert!(!read["requests"]
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["method"] == "turn/interrupt" || r["method"] == "thread/resume"));
    c.stop().await;
}
#[tokio::test]
async fn steer_uses_exact_turn_with_native_attachments_and_no_settings_overrides() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    let t = c
        .request("thread/start", json!({"cwd":root.path()}))
        .await
        .unwrap();
    let id = t["thread"]["id"].as_str().unwrap();
    let turn = c
        .request("turn/start", json!({"threadId":id}))
        .await
        .unwrap();
    let turn_id = turn["turn"]["id"].as_str().unwrap();
    assert!(steer(&c, id, "stale", "text", vec![], "client-stale")
        .await
        .is_err());
    steer(
        &c,
        id,
        turn_id,
        "Focus on tests",
        vec![json!({"type":"localImage","path":"/fixture/image.png"})],
        "client-message",
    )
    .await
    .unwrap();
    let read = c
        .request("thread/read", json!({"threadId":id}))
        .await
        .unwrap();
    let requests: Vec<_> = read["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["method"] == "turn/steer")
        .collect();
    assert_eq!(requests.len(), 1);
    let p = &requests[0]["params"];
    assert_eq!(p["expectedTurnId"], turn_id);
    assert_eq!(p["input"][0]["text"], "Focus on tests");
    assert_eq!(p["input"][1]["type"], "localImage");
    assert_eq!(p.as_object().unwrap().len(), 4);
    assert_eq!(p["clientUserMessageId"], "client-message");
    assert_eq!(c.active.lock().await.get(id).unwrap(), turn_id);
    c.stop().await;
}

#[tokio::test]
async fn archive_blocks_running_descendants_but_allows_unrelated_work() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    let parent = c
        .request("thread/start", json!({"cwd":root.path()}))
        .await
        .unwrap();
    let parent_id = parent["thread"]["id"].as_str().unwrap();
    let child = c
        .request(
            "thread/start",
            json!({"cwd":root.path(),"parentId":parent_id}),
        )
        .await
        .unwrap();
    c.request("turn/start", json!({"threadId":child["thread"]["id"]}))
        .await
        .unwrap();
    assert!(manage(&c, root.path(), parent_id, "archive", None)
        .await
        .is_err());
    let unrelated = c
        .request("thread/start", json!({"cwd":root.path()}))
        .await
        .unwrap();
    manage(
        &c,
        root.path(),
        unrelated["thread"]["id"].as_str().unwrap(),
        "archive",
        None,
    )
    .await
    .unwrap();
    assert!(c
        .active
        .lock()
        .await
        .contains_key(child["thread"]["id"].as_str().unwrap()));
    c.stop().await;
}

#[tokio::test]
async fn new_chat_access_levels_validate_against_codex_permission_options() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    let options = bindaas::codex::session::permission_options(&c, root.path())
        .await
        .unwrap();
    for access in ["standard", "full"] {
        let (profile, policy) = bindaas::codex::session::new_chat_permissions(access);
        bindaas::codex::session::validate_permissions(&options, Some(profile), Some(policy))
            .unwrap_or_else(|e| panic!("{access}: {e}"));
    }
    c.stop().await;
}
#[tokio::test]
async fn full_access_default_respects_codex_managed_requirements() {
    let root = tempfile::tempdir().unwrap();
    let c = client().await;
    c.request("thread/start", json!({"cwd":root.path(),"managed":true}))
        .await
        .unwrap();
    let options = bindaas::codex::session::permission_options(&c, root.path())
        .await
        .unwrap();
    let (profile, policy) = bindaas::codex::session::new_chat_permissions("full");
    assert!(
        bindaas::codex::session::validate_permissions(&options, Some(profile), Some(policy))
            .is_err()
    );
    c.stop().await;
}
