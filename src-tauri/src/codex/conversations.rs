use super::Client;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub async fn verify_thread(c: &Client, id: &str, root: &std::path::Path) -> Result<Value, String> {
    let v = c
        .request("thread/read", json!({"threadId":id,"includeTurns":false}))
        .await?;
    let cwd = v["thread"]["cwd"]
        .as_str()
        .ok_or("Thread has no project directory")?;
    if PathBuf::from(cwd)
        .canonicalize()
        .map_err(|e| e.to_string())?
        != root.canonicalize().map_err(|e| e.to_string())?
    {
        return Err("Thread belongs to another project".into());
    }
    Ok(v)
}

/// Drops `before_turn_id` and every later turn from the conversation history.
/// Local files changed by those turns are not reverted.
pub async fn revert(
    c: &Client,
    root: &Path,
    thread_id: &str,
    before_turn_id: &str,
) -> Result<Value, String> {
    let current = verify_thread(c, thread_id, root).await?;
    if current["thread"]["status"]["type"].as_str() == Some("active") {
        return Err("Stop the running task before editing an earlier message".into());
    }
    c.request(
        "thread/revert",
        json!({"threadId": thread_id, "beforeTurnId": before_turn_id}),
    )
    .await
}

pub async fn manage(
    c: &Client,
    root: &Path,
    thread_id: &str,
    action: &str,
    name: Option<&str>,
) -> Result<Value, String> {
    let current = verify_thread(c, thread_id, root).await?;
    match action {
        "rename" => {
            let name = name.unwrap_or("").trim();
            if name.is_empty() || name.chars().count() > 200 {
                return Err("Use a conversation title between 1 and 200 characters".into());
            }
            c.request("thread/name/set", json!({"threadId":thread_id,"name":name}))
                .await
        }
        "archive" => {
            let mut family = vec![current["thread"].clone()];
            let mut cursor = Value::Null;
            for page in 0..20 {
                let v = c.request("thread/list", json!({"ancestorThreadId":thread_id,"archived":false,"limit":100,"cursor":cursor})).await?;
                let children = v["data"]
                    .as_array()
                    .ok_or("Codex did not report child conversations")?;
                family.extend(children.iter().cloned());
                cursor = v["nextCursor"].clone();
                if cursor.is_null() {
                    break;
                }
                if page == 19 {
                    return Err("Too many child conversations to safely archive at once".into());
                }
            }
            let active = c.active.lock().await;
            let approvals = c.approvals.lock().await;
            if family.iter().any(|t| {
                t["status"]["type"] == "active"
                    || t["id"].as_str().is_some_and(|id| {
                        active.contains_key(id)
                            || approvals.values().any(|a| a.params["threadId"] == id)
                    })
            }) {
                return Err("Finish this conversation and its child tasks before archiving".into());
            }
            drop(approvals);
            drop(active);
            c.request("thread/archive", json!({"threadId":thread_id}))
                .await
        }
        "restore" => {
            c.request("thread/unarchive", json!({"threadId":thread_id}))
                .await
        }
        _ => Err("Unknown conversation action".into()),
    }
}

pub async fn steer(
    c: &Client,
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    attachments: Vec<Value>,
    client_user_message_id: &str,
) -> Result<Value, String> {
    if c.active.lock().await.get(thread_id).map(String::as_str) != Some(turn_id) {
        return Err("This turn is no longer active. The message was not sent.".into());
    }
    let input = super::input::turn_overrides(thread_id, prompt, attachments, None, None, None)
        ["input"]
        .clone();
    c.request(
        "turn/steer",
        json!({"threadId":thread_id,"expectedTurnId":turn_id,"input":input,"clientUserMessageId":client_user_message_id}),
    )
    .await
}
