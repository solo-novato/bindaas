//! Explicit service-tier changes. Never interrupt, resume, or send a model turn.
use super::Client;
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, sync::Arc};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub thread_id: String,
    pub turn_id: Option<String>,
}

pub async fn apply(
    c: Arc<Client>,
    root: &Path,
    targets: Vec<Target>,
    fast: bool,
) -> Result<Vec<Value>, String> {
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let root = canonical_root.as_path();
    let mut ids = HashSet::new();
    if targets.is_empty()
        || targets.len() > 32
        || targets
            .iter()
            .any(|t| t.thread_id.is_empty() || !ids.insert(&t.thread_id))
    {
        return Err("Choose between 1 and 32 distinct conversations".into());
    }
    Ok(stream::iter(targets.into_iter().map(|target| {
        let c = c.clone();
        async move {
            let result = apply_one(&c, root, &target, fast).await;
            match result {
                Ok(value) => value,
                Err(error) => json!({"threadId":target.thread_id,"turnId":target.turn_id,
                    "future":"failed","active":"notChanged","error":error}),
            }
        }
    }))
    .buffered(4)
    .collect()
    .await)
}

async fn apply_one(c: &Client, root: &Path, target: &Target, fast: bool) -> Result<Value, String> {
    let id = &target.thread_id;
    let current = c
        .request("thread/read", json!({"threadId":id,"includeTurns":false}))
        .await?;
    let cwd = current["thread"]["cwd"]
        .as_str()
        .ok_or("Thread has no project directory")?;
    if Path::new(cwd).canonicalize().map_err(|e| e.to_string())? != root {
        return Err("Thread belongs to another project".into());
    }
    if !c.resumed.lock().await.contains_key(id) && !c.active.lock().await.contains_key(id) {
        return Err("Open this conversation in Bindaas before changing its speed".into());
    }
    // null explicitly clears Fast, as in Codex's /fast off command.
    let tier = if fast { json!("fast") } else { Value::Null };
    let future = c
        .update_settings(json!({"threadId":id,"serviceTier":tier}))
        .await;
    let mut result = json!({"threadId":id,"turnId":target.turn_id,
        "future":if future.is_ok() {"saved"} else {"failed"},"active":"notTargeted"});
    if let Err(error) = future {
        result["futureError"] = json!(error);
    }
    if let Some(turn_id) = &target.turn_id {
        // Do not let a delayed click change a replacement turn.
        if c.active.lock().await.get(id) != Some(turn_id) || turn_id.is_empty() {
            result["active"] = json!("targetUnavailable");
        } else {
            match c
                .request(
                    "turn/settings/update",
                    json!({"threadId":id,"turnId":turn_id,"serviceTier":tier}),
                )
                .await
            {
                Ok(reply)
                    if matches!(
                        reply["status"].as_str(),
                        Some("applied" | "targetUnavailable")
                    ) =>
                {
                    result["active"] = reply["status"].clone();
                }
                Ok(_) => {
                    result["active"] = json!("failed");
                    result["activeError"] =
                        json!("Codex did not confirm the running task's speed change");
                }
                Err(error) => {
                    result["active"] = json!("failed");
                    result["activeError"] = json!(error);
                }
            }
        }
    }
    result["settings"] = c
        .settings
        .lock()
        .await
        .get(id)
        .cloned()
        .unwrap_or(Value::Null);
    Ok(result)
}
