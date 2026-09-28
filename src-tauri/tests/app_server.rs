use bindaas::codex::{start_idle_task, Client, Manager, Sink};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc, Mutex as StdMutex},
    time::Duration,
};
use tokio::sync::{Mutex, Notify};
type Events = Arc<StdMutex<Vec<(String, Value)>>>;
#[tokio::test]
async fn codex_thread_names_are_forwarded_including_removal() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    c.request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    wait_event(&events, "codex://thread-name").await;
    events.lock().unwrap().clear();
    c.request(
        "thread/name/set",
        json!({"threadId":"fixture-thread","name":"Generated conversation title"}),
    )
    .await
    .unwrap();
    wait_event(&events, "codex://thread-name").await;
    {
        let e = events.lock().unwrap();
        let (_, title) = e
            .iter()
            .find(|(name, _)| name == "codex://thread-name")
            .unwrap();
        assert_eq!(title["threadId"], "fixture-thread");
        assert_eq!(title["name"], "Generated conversation title");
        assert_eq!(title["generation"], 1);
    }
    events.lock().unwrap().clear();
    c.request(
        "thread/name/set",
        json!({"threadId":"fixture-thread","name":null}),
    )
    .await
    .unwrap();
    wait_event(&events, "codex://thread-name").await;
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|(name, value)| name == "codex://thread-name" && value["name"].is_null()));
    c.stop().await;
}
#[tokio::test]
async fn run_list_reads_latest_plan_metadata_without_resuming_threads() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "propose-plan").await;
    wait_event(&events, "codex://turn-completed").await;
    let page = c.request("thread/list", json!({})).await.unwrap();
    let rows = bindaas::codex::runs::summaries(c.clone(), page["data"].as_array().unwrap()).await;
    assert_eq!(rows[0]["runStatus"], "planGenerated");
    assert_eq!(rows[0]["latestTurnId"], "fixture-turn-1");
    assert!(rows[0].get("turns").is_none());
    let state = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    assert_eq!(state["testResumeCount"], 0);
    assert_eq!(
        state["testLastTurnsParams"],
        json!({"threadId":"fixture-thread","limit":1,"sortDirection":"desc","itemsView":"summary"})
    );
    c.stop().await;
}
#[tokio::test]
async fn login_completion_releases_idle_protection() {
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    c.login.store(true, Ordering::SeqCst);
    assert!(!c.idle().await);
    let result = c
        .request("account/login/start", json!({"type":"chatgpt"}))
        .await
        .unwrap();
    assert_eq!(result["loginId"], "fixture-login");
    wait_event(&events, "codex://auth-updated").await;
    assert!(c.idle().await);
    let pid = c.pid;
    c.stop().await;
    #[cfg(unix)]
    assert_eq!(
        unsafe { libc::kill(pid as i32, 0) },
        -1,
        "owned child must be reaped before stop returns"
    );
}
#[tokio::test]
async fn resumed_running_turn_blocks_idle_shutdown() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "wait").await;
    wait_event(&events, "codex://turn-started").await;
    c.active.lock().await.clear();
    let response = c
        .request(
            "thread/resume",
            json!({"threadId":"fixture-thread","cwd":project.path()}),
        )
        .await
        .unwrap();
    c.observe_resumed(&response).await.unwrap();
    assert_eq!(c.active.lock().await["fixture-thread"], "fixture-turn-1");
    assert!(!c.idle().await);
    c.stop().await;
}
#[tokio::test]
async fn completion_clears_turn_reservation_before_resume_response() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "wait").await;
    wait_event(&events, "codex://turn-started").await;
    c.active
        .lock()
        .await
        .insert("fixture-thread".into(), String::new());
    c.request(
        "turn/interrupt",
        json!({"threadId":"fixture-thread","turnId":"fixture-turn-1"}),
    )
    .await
    .unwrap();
    wait_event(&events, "codex://turn-completed").await;
    assert!(c.active.lock().await.is_empty());
    c.stop().await;
}
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/fake-app-server.mjs")
}
fn sink() -> (Events, Sink) {
    let events = Arc::new(StdMutex::new(vec![]));
    let e = events.clone();
    (
        events,
        Arc::new(move |name, value| e.lock().unwrap().push((name.into(), value))),
    )
}
async fn wait_event(events: &Events, name: &str) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if events.lock().unwrap().iter().any(|(n, _)| n == name) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
async fn start(c: &Client, root: &std::path::Path, prompt: &str) {
    c.request("thread/start", json!({"cwd":root}))
        .await
        .unwrap();
    c.request("turn/start",json!({"threadId":"fixture-thread","input":[{"type":"text","text":prompt,"text_elements":[]}]})).await.unwrap();
}

#[tokio::test]
async fn complete_workflow_and_truth() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    let models = c.request("model/list", json!({})).await.unwrap();
    assert_eq!(models["data"][0]["model"], "fixture-model");
    start(&c, project.path(), "change file").await;
    wait_event(&events, "codex://turn-completed").await;
    let e = events.lock().unwrap().clone();
    assert!(e.iter().any(|(n, _)| n == "codex://turn-diff"));
    assert!(e
        .iter()
        .any(|(n, v)| n == "codex://timeline-item" && v["kind"] == "fileChange"));
    assert!(e.iter().any(|(_, v)| v["exitCode"] == 0));
    assert!(e.iter().any(|(n, v)| n == "codex://timeline-item"
        && v["phase"] == "final_answer"
        && v["status"] == "completed"));
    assert!(!serde_json::to_string(&e)
        .unwrap()
        .contains("NEVER_RENDER_THIS"));
    assert_eq!(
        std::fs::read_to_string(project.path().join("hello.txt")).unwrap(),
        "after\n"
    );
    assert!(c.idle().await);
    c.stop().await;
}
#[tokio::test]
async fn approvals_are_exactly_once_and_generation_scoped() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 9, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "approval").await;
    wait_event(&events, "codex://approval-requested").await;
    let approval = events
        .lock()
        .unwrap()
        .iter()
        .find(|(n, _)| n == "codex://approval-requested")
        .unwrap()
        .1
        .clone();
    let id = approval["requestId"].as_str().unwrap();
    assert_eq!(approval["network"]["host"], "registry.npmjs.org");
    assert!(!c.idle().await);
    assert!(c.respond(8, id, json!("accept"), None).await.is_err());
    assert!(c
        .respond(9, id, json!("acceptForSession"), None)
        .await
        .is_err());
    c.respond(9, id, json!("accept"), None).await.unwrap();
    assert!(c.respond(9, id, json!("accept"), None).await.is_err());
    wait_event(&events, "codex://turn-completed").await;
    assert!(c.approvals.lock().await.is_empty());
    c.stop().await;
}
#[tokio::test]
async fn disconnect_does_not_fabricate_completion() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "disconnect").await;
    wait_event(&events, "codex://connection").await;
    tokio::time::timeout(Duration::from_secs(4), async {
        while c.alive.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(!events
        .lock()
        .unwrap()
        .iter()
        .any(|(n, _)| n == "codex://turn-completed"));
    assert!(c.request("model/list", json!({})).await.is_err());
    c.stop().await;
}
#[tokio::test]
async fn idle_sleep_restart_resume_and_active_protection() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let mut manager = Manager::new(sink);
    manager.executable = Some(fixture().to_string_lossy().into_owned());
    manager.idle_timeout = Duration::from_millis(100);
    let wake = manager.wake.clone();
    let manager = Arc::new(Mutex::new(manager));
    start_idle_task(manager.clone(), wake);
    let c = manager.lock().await.ready().await.unwrap();
    start(&c, project.path(), "wait").await;
    tokio::time::sleep(Duration::from_millis(180)).await;
    assert!(c.alive.load(Ordering::SeqCst));
    assert!(manager.lock().await.sleep(false).await.is_err());
    c.request(
        "turn/interrupt",
        json!({"threadId":"fixture-thread","turnId":"fixture-turn-1"}),
    )
    .await
    .unwrap();
    wait_event(&events, "codex://turn-completed").await;
    tokio::time::timeout(Duration::from_secs(3), async {
        while c.alive.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let second = manager.lock().await.ready().await.unwrap();
    assert_ne!(c.generation, second.generation);
    let v = second
        .request(
            "thread/resume",
            json!({"threadId":"fixture-thread","cwd":project.path()}),
        )
        .await
        .unwrap();
    assert_eq!(v["thread"]["id"], "fixture-thread");
    second.request("turn/start",json!({"threadId":"fixture-thread","input":[{"type":"text","text":"follow up","text_elements":[]}]})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(90)).await;
    assert_eq!(
        std::fs::read_to_string(project.path().join("hello.txt")).unwrap(),
        "after\n"
    );
    manager.lock().await.sleep(true).await.unwrap();
}
#[tokio::test]
async fn huge_output_is_bounded_and_completion_authoritative() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "huge").await;
    wait_event(&events, "codex://turn-completed").await;
    assert!(c
        .output
        .lock()
        .await
        .values()
        .all(|s| s.len() <= 1024 * 1024));
    // Check the recorded events without holding the lock across an await.
    let truncated = events.lock().unwrap().clone();
    let e = &truncated;
    assert!(e.iter().any(|(name, p)| name == "codex://timeline-update"
        && p.as_array().unwrap().iter().any(|v| v["truncated"] == true)));
    c.stop().await;
}
#[tokio::test]
async fn non_git_project_stays_usable() {
    let project = tempfile::tempdir().unwrap();
    assert!(!bindaas::git::snapshot(project.path()).await.available);
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "change").await;
    wait_event(&events, "codex://turn-completed").await;
    assert!(bindaas::files::read(&project.path().canonicalize().unwrap(), "hello.txt").is_ok());
    c.stop().await;
}

#[tokio::test]
async fn webview_reattaches_without_resuming_or_interrupting_an_active_turn() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "wait").await;
    wait_event(&events, "codex://turn-started").await;
    let current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    let before = current["testResumeCount"].clone();
    let pid = c.pid;
    c.resume_or_attach("fixture-thread", project.path(), current)
        .await
        .unwrap();
    let after = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    assert_eq!(
        after["testResumeCount"], before,
        "Reattaching must not send thread/resume while work is active"
    );
    assert_eq!(c.pid, pid);
    assert!(!c.active.lock().await.is_empty());
    assert!(!c.idle().await);
    c.stop().await;
}

#[tokio::test]
async fn settings_notifications_and_reattach_use_codex_values_without_permission_overrides() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    c.request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    let current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    let resumed = c
        .resume_or_attach("fixture-thread", project.path(), current)
        .await
        .unwrap();
    c.update_settings(json!({"threadId":"fixture-thread","collaborationMode":{"mode":"plan","settings":{"model":"server-model","reasoning_effort":"high","developer_instructions":null}}})).await.unwrap();
    wait_event(&events, "codex://thread-settings").await;
    let current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    assert_eq!(
        current["testLastResumeParams"],
        json!({"threadId":"fixture-thread","excludeTurns":true})
    );
    let attached = c
        .resume_or_attach("fixture-thread", project.path(), current)
        .await
        .unwrap();
    let settings = c.effective_settings("fixture-thread", &attached).await;
    assert_eq!(settings["model"], "server-model");
    assert_eq!(settings["effort"], "high");
    assert_eq!(settings["mode"], "plan");
    assert_eq!(settings["approvalPolicy"], "never");
    assert_eq!(settings["sandbox"]["type"], "readOnly");
    assert_ne!(settings["model"], resumed["model"]);
    c.stop().await;
}

#[tokio::test]
async fn fresh_resume_recovers_plan_from_codex_rollout() {
    use std::io::Write;
    let project = tempfile::tempdir().unwrap();
    let (_events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    c.request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    let mut current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    let mut rollout = tempfile::NamedTempFile::new().unwrap();
    writeln!(
        rollout,
        "{}",
        json!({"type":"session_meta","payload":{"id":"fixture-thread"}})
    )
    .unwrap();
    writeln!(rollout, "{}", json!({"type":"turn_context","payload":{"turn_id":"previous","model":"saved-model","effort":"high","collaboration_mode":{"mode":"plan"}}})).unwrap();
    current["thread"]["path"] = json!(rollout.path());
    let resumed = c
        .resume_or_attach("fixture-thread", project.path(), current)
        .await
        .unwrap();
    let settings = c.effective_settings("fixture-thread", &resumed).await;
    assert_eq!(settings["mode"], "plan");
    assert_eq!(settings["model"], "saved-model");
    assert_eq!(settings["effort"], "high");
    c.stop().await;
}

#[tokio::test]
async fn permission_changes_keep_model_mode_and_block_active_turns() {
    use bindaas::codex::session;
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    c.request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    c.update_settings(json!({"threadId":"fixture-thread","collaborationMode":{"mode":"plan","settings":{"model":"server-model","reasoning_effort":"high","developer_instructions":null}}})).await.unwrap();
    let current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    let result = session::set_permissions(
        &c,
        project.path(),
        "fixture-thread",
        current,
        Some(":read-only"),
        Some("untrusted"),
    )
    .await
    .unwrap();
    assert_eq!(result["permissionProfile"]["id"], ":read-only");
    assert_eq!(result["approvalPolicy"], "untrusted");
    assert_eq!(result["model"], "server-model");
    assert_eq!(result["mode"], "plan");
    assert_eq!(result["effort"], "high");
    start(&c, project.path(), "wait").await;
    wait_event(&events, "codex://token-usage").await;
    assert_eq!(
        c.usage.lock().await["fixture-thread"]["last"]["inputTokens"],
        1000
    );
    let current = c
        .request("thread/read", json!({"threadId":"fixture-thread"}))
        .await
        .unwrap();
    assert!(session::set_permissions(
        &c,
        project.path(),
        "fixture-thread",
        current,
        Some(":workspace"),
        None
    )
    .await
    .unwrap_err()
    .contains("Finish or stop"));
    c.stop().await;
}

#[tokio::test]
async fn concurrent_threads_keep_approvals_output_and_idle_state_independent() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/concurrent-app-server.mjs"),
        4,
        sink,
        Arc::new(Notify::new()),
    )
    .await
    .unwrap();
    let first = c
        .request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    let a = first["thread"]["id"].as_str().unwrap();
    let ta = c
        .request("turn/start", json!({"threadId":a}))
        .await
        .unwrap();
    let second = c
        .request("thread/start", json!({"cwd":project.path()}))
        .await
        .unwrap();
    let b = second["thread"]["id"].as_str().unwrap();
    // Browsing another idle thread must not interrupt/resume the active one.
    c.resume_or_attach(b, project.path(), second.clone())
        .await
        .unwrap();
    let tb = c
        .request("turn/start", json!({"threadId":b}))
        .await
        .unwrap();
    c.request("thread/read", json!({"threadId":b}))
        .await
        .unwrap();
    assert_eq!(c.active.lock().await.len(), 2);
    assert_eq!(c.approvals.lock().await.len(), 2);
    assert!(!c.idle().await);
    let current = c
        .request("thread/read", json!({"threadId":a}))
        .await
        .unwrap();
    c.resume_or_attach(a, project.path(), current)
        .await
        .unwrap();
    assert_eq!(c.active.lock().await.len(), 2);
    assert!(c
        .request("turn/start", json!({"threadId":a}))
        .await
        .is_err());
    assert!(c.alive.load(Ordering::SeqCst));
    let output = c.output.lock().await.clone();
    assert_eq!(
        output[&format!("{a}:{}:same-command-id", ta["turn"]["id"].as_str().unwrap())],
        format!("Output for {a}")
    );
    assert_eq!(
        output[&format!("{b}:{}:same-command-id", tb["turn"]["id"].as_str().unwrap())],
        format!("Output for {b}")
    );
    let captured = events.lock().unwrap().clone();
    assert!(!serde_json::to_string(&captured)
        .unwrap()
        .contains("NEVER_RENDER_THIS"));
    assert!(captured
        .iter()
        .any(|(name, p)| name == "codex://timeline-update"
            && p.as_array()
                .unwrap()
                .iter()
                .any(|d| d["kind"] == "thinking" && d["summaryIndex"] == 1)));
    c.request(
        "turn/interrupt",
        json!({"threadId":a,"turnId":ta["turn"]["id"]}),
    )
    .await
    .unwrap();
    c.request("thread/read", json!({"threadId":a}))
        .await
        .unwrap();
    assert!(!c.active.lock().await.contains_key(a));
    assert!(c.active.lock().await.contains_key(b));
    assert_eq!(c.approvals.lock().await.len(), 1);
    assert!(!c.idle().await);
    c.request(
        "turn/interrupt",
        json!({"threadId":b,"turnId":tb["turn"]["id"]}),
    )
    .await
    .unwrap();
    c.request("thread/read", json!({"threadId":b}))
        .await
        .unwrap();
    assert!(c.idle().await);
    c.stop().await;
}

#[tokio::test]
async fn proposed_plan_stream_and_progress_remain_distinct_and_final_text_wins() {
    let project = tempfile::tempdir().unwrap();
    let (events, sink) = sink();
    let c = Client::spawn(&fixture(), 1, sink, Arc::new(Notify::new()))
        .await
        .unwrap();
    start(&c, project.path(), "propose-plan").await;
    wait_event(&events, "codex://turn-completed").await;
    {
        let events = events.lock().unwrap();
        assert!(events
            .iter()
            .any(|(name, value)| name == "codex://timeline-update"
                && value.as_array().is_some_and(|deltas| deltas
                    .iter()
                    .any(|d| d["kind"] == "plan" && d["delta"] == "Draft approach"))));
        let plan = events
            .iter()
            .rev()
            .find(|(name, value)| name == "codex://timeline-item" && value["kind"] == "plan")
            .unwrap();
        assert_eq!(
            plan.1["text"],
            "# Final proposal\n\nUse the existing request pipeline."
        );
        assert_eq!(plan.1["status"], "completed");
        assert!(plan.1.get("phase").is_none());
        let progress = events
            .iter()
            .find(|(name, value)| {
                name == "codex://timeline-item" && value["kind"] == "planProgress"
            })
            .unwrap();
        assert_eq!(progress.1["steps"][1]["status"], "inProgress");
        assert_eq!(progress.1["status"], "recorded");
    }
    let history = c
        .request(
            "thread/read",
            json!({"threadId":"fixture-thread","includeTurns":true}),
        )
        .await
        .unwrap();
    let plan = history["thread"]["turns"][0]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "plan")
        .unwrap();
    let restored = bindaas::codex::normalize::history_item(
        plan,
        "fixture-thread",
        "fixture-turn-1",
        true,
        None,
    )
    .unwrap();
    assert_eq!(restored["kind"], "plan");
    assert_eq!(
        restored["text"],
        "# Final proposal\n\nUse the existing request pipeline."
    );
    c.stop().await;
}
