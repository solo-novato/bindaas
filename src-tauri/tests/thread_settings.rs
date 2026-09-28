use bindaas::codex::thread_settings;
use serde_json::{json, Value};
use std::io::Write;
fn fixture(records: Vec<Value>) -> (tempfile::NamedTempFile, Value) {
    let mut file = tempfile::NamedTempFile::new().unwrap();
    writeln!(
        file,
        "{}",
        json!({"type":"session_meta","payload":{"id":"thread"}})
    )
    .unwrap();
    for record in records {
        writeln!(file, "{record}").unwrap();
    }
    let thread = json!({"id":"thread","path":file.path()});
    (file, thread)
}
fn context(turn: &str, model: &str, mode: &str) -> Value {
    json!({"type":"turn_context","payload":{"turn_id":turn,"model":model,"effort":"high","collaboration_mode":{"mode":mode,"settings":{"developer_instructions":"PRIVATE"}},"sandbox_policy":{"type":"read-only"},"approval_policy":"never"}})
}
#[test]
fn codex_records_distinguish_last_used_turn_from_later_settings() {
    let (_file, thread) = fixture(vec![
        context("old", "old-model", "default"),
        context("latest", "new-model", "plan"),
        json!({"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"thread","thread_settings":{"model":"next-model","reasoning_effort":"low","collaboration_mode":{"mode":"default"}}}}),
    ]);
    let result = thread_settings::read(&thread);
    assert_eq!(result.latest.as_ref().unwrap()["model"], "next-model");
    assert_eq!(result.latest.as_ref().unwrap()["mode"], "default");
    assert_eq!(result.turns["latest"]["mode"], "plan");
    assert_eq!(result.turns["latest"]["effort"], "high");
    assert_eq!(result.turns["old"]["model"], "old-model");
    assert!(!serde_json::to_string(&result.turns)
        .unwrap()
        .contains("PRIVATE"));
}
#[test]
fn absent_or_unknown_metadata_never_claims_code_mode() {
    assert!(thread_settings::read(&json!({"id":"thread"}))
        .latest
        .is_none());
    let (mut file, mut thread) = fixture(vec![context("latest", "model", "future-mode")]);
    writeln!(file, "{{truncated").unwrap();
    assert!(thread_settings::read(&thread).latest.unwrap()["mode"].is_null());
    thread["id"] = json!("different-thread");
    assert!(thread_settings::read(&thread).latest.is_none());
}
#[test]
fn bounded_tail_can_recover_recent_context_after_large_output() {
    let (mut file, thread) = fixture(vec![]);
    file.write_all(&vec![b'x'; 17 * 1024 * 1024]).unwrap();
    writeln!(file, "\n{}", context("latest", "model", "plan")).unwrap();
    assert_eq!(
        thread_settings::read(&thread).latest.unwrap()["mode"],
        "plan"
    );
}
#[test]
fn live_settings_are_whitelisted_and_keep_unknowns_null() {
    let value = thread_settings::live(
        &json!({"model":"live-model","effort":null,"collaborationMode":{"mode":"plan","settings":{"developer_instructions":"PRIVATE"}},"sandboxPolicy":{"type":"readOnly"},"approvalPolicy":"never"}),
    );
    assert_eq!(value["mode"], "plan");
    assert!(value["effort"].is_null());
    assert_eq!(value["sandbox"]["type"], "readOnly");
    assert!(!value.to_string().contains("PRIVATE"));
}

#[test]
fn restored_usage_and_limits_are_bounded_whitelisted_and_unknown_safe() {
    use bindaas::codex::session;
    let (_file, thread) = fixture(vec![
        json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":12345,"input_tokens":12000},"last_token_usage":{"input_tokens":2000},"model_context_window":128000}}}),
    ]);
    let usage = thread_settings::read(&thread).usage;
    assert_eq!(usage["total"]["totalTokens"], 12345);
    assert_eq!(usage["last"]["inputTokens"], 2000);
    assert!(usage["last"]["outputTokens"].is_null());
    assert_eq!(usage["modelContextWindow"], 128000);
    let limits = session::limits(
        &json!({"accountId":"DO_NOT_EXPOSE","ordinaryUsageAllowed":false,"rateLimits":{"limitId":"codex","primary":{"usedPercent":100,"resetsAt":1000}}}),
    );
    assert!(!limits.to_string().contains("DO_NOT_EXPOSE"));
    assert_eq!(limits["ordinaryUsageAllowed"], false);
    assert!(limits["buckets"][0]["secondary"].is_null());
    assert!(session::token_usage(&Value::Null, false).is_null());
}

#[test]
fn permissions_reject_unlisted_profiles_and_managed_approval_policies() {
    use bindaas::codex::session::validate_permissions;
    let options = json!({"profiles":[{"id":":read-only","allowed":true},{"id":":danger-full-access","allowed":false}],"approvalPolicies":["on-request"]});
    assert!(validate_permissions(&options, Some(":read-only"), Some("on-request")).is_ok());
    assert!(validate_permissions(&options, Some(":danger-full-access"), None).is_err());
    assert!(validate_permissions(&options, Some("unknown"), None).is_err());
    assert!(validate_permissions(&options, None, Some("never")).is_err());
    assert!(validate_permissions(&options, None, None).is_ok());
}
