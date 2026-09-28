//! Codex owns these records. Never persist a second copy in Bindaas preferences.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
};

const TAIL_CAP: u64 = 16 * 1024 * 1024;
const LINE_CAP: usize = 2 * 1024 * 1024;
#[derive(Default)]
pub struct Recorded {
    pub latest: Option<Value>,
    pub usage: Value,
    pub turns: HashMap<String, Value>,
}
fn mode(value: &Value) -> Value {
    match value.as_str() {
        Some("plan" | "default") => value.clone(),
        _ => Value::Null,
    }
}
pub fn live(s: &Value) -> Value {
    json!({"model":s["model"],"effort":s["effort"],
        "mode":mode(&s["collaborationMode"]["mode"]),"sandbox":s["sandboxPolicy"],
        "approvalPolicy":s["approvalPolicy"],"approvalsReviewer":s["approvalsReviewer"],
        "permissionProfile":s["activePermissionProfile"],"cwd":s["cwd"],"modelProvider":s["modelProvider"],"serviceTier":s["serviceTier"]})
}
pub fn resumed(s: &Value) -> Value {
    json!({"model":s["model"],"effort":s["reasoningEffort"],"mode":null,
        "sandbox":s["sandbox"],"approvalPolicy":s["approvalPolicy"],
        "approvalsReviewer":s["approvalsReviewer"],"permissionProfile":s["activePermissionProfile"],"cwd":s["cwd"],"modelProvider":s["modelProvider"],"serviceTier":s["serviceTier"]})
}
fn context(s: &Value) -> Value {
    json!({"model":s["model"],"effort":s["effort"],
        "mode":mode(&s["collaboration_mode"]["mode"]),"sandbox":s["sandbox_policy"],
        "approvalPolicy":s["approval_policy"],"approvalsReviewer":s["approvals_reviewer"],
        "permissionProfile":s["permission_profile"]})
}
fn applied(s: &Value) -> Value {
    json!({"model":s["model"],"effort":s["reasoning_effort"],
        "mode":mode(&s["collaboration_mode"]["mode"]),"sandbox":null,
        "approvalPolicy":s["approval_policy"],"approvalsReviewer":s["approvals_reviewer"],
        "permissionProfile":s["active_permission_profile"]})
}
/// Path comes ONLY from a project-verified App Server thread/read or resume response.
/// Validate the session identity and read a bounded tail; never expose prompt/instructions.
pub fn read(thread: &Value) -> Recorded {
    fn inner(thread: &Value) -> Option<Recorded> {
        let id = thread["id"].as_str()?;
        let mut file = File::open(thread["path"].as_str()?).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut head = vec![0; 64 * 1024];
        let n = file.read(&mut head).ok()?;
        let end = head[..n].iter().position(|b| *b == b'\n')?;
        let meta: Value = serde_json::from_slice(&head[..end]).ok()?;
        if meta["type"] != "session_meta" || meta["payload"]["id"] != id {
            return None;
        }
        let len = file.metadata().ok()?.len();
        let start = len.saturating_sub(TAIL_CAP);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut bytes = Vec::new();
        file.take(TAIL_CAP).read_to_end(&mut bytes).ok()?;
        let mut result = Recorded::default();
        for (index, line) in bytes.split(|b| *b == b'\n').enumerate() {
            if (start > 0 && index == 0) || line.len() > LINE_CAP {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            let p = &record["payload"];
            if record["type"] == "turn_context" {
                let settings = context(p);
                result.latest = Some(settings.clone());
                if let Some(turn) = p["turn_id"].as_str() {
                    if result.turns.len() >= 400 {
                        result.turns.clear();
                    }
                    result.turns.insert(turn.into(), settings);
                }
            } else if record["type"] == "event_msg"
                && p["type"] == "thread_settings_applied"
                && p["thread_id"] == id
            {
                result.latest = Some(applied(&p["thread_settings"]));
            } else if record["type"] == "event_msg"
                && p["type"] == "token_count"
                && p["info"].is_object()
            {
                result.usage = super::session::token_usage(&p["info"], true);
            }
        }
        Some(result)
    }
    inner(thread).unwrap_or_default()
}
pub async fn recorded(thread: Value) -> Recorded {
    tokio::task::spawn_blocking(move || read(&thread))
        .await
        .unwrap_or_default()
}
