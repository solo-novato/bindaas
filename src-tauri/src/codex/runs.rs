use super::Client;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;

pub fn status(runtime: &Value, turn: Option<&Value>) -> &'static str {
    match runtime["type"].as_str() {
        Some("active") => {
            let flags = runtime["activeFlags"].as_array();
            if flags.is_some_and(|f| f.iter().any(|v| v == "waitingOnUserInput")) {
                return "waitingInput";
            }
            if flags.is_some_and(|f| f.iter().any(|v| v == "waitingOnApproval")) {
                return "waitingApproval";
            }
            return "running";
        }
        Some("systemError") => return "error",
        _ => {}
    }
    match turn.and_then(|t| t["status"].as_str()) {
        Some("inProgress") => "running",
        Some("completed") => {
            if turn.is_some_and(|t| {
                t["items"]
                    .as_array()
                    .is_some_and(|items| items.iter().any(|item| item["type"] == "plan"))
            }) {
                "planGenerated"
            } else {
                "completed"
            }
        }
        Some("failed") => "failed",
        Some("interrupted") => "interrupted",
        _ if runtime["type"] == "idle" => "idle",
        _ => "unknown",
    }
}

pub fn summary(thread: &Value) -> Value {
    json!({"id":thread["id"],"preview":thread["preview"],"name":thread["name"],"cwd":thread["cwd"],"createdAt":thread["createdAt"],"updatedAt":thread["updatedAt"],"status":thread["status"],"model":thread["model"],"runStatus":status(&thread["status"],None)})
}

/// On-demand, bounded metadata reads. Do not resume threads or fetch full item bodies.
pub async fn summaries(client: Arc<Client>, threads: &[Value]) -> Vec<Value> {
    stream::iter(threads.iter().take(30).cloned())
        .map(|thread| {
            let client = client.clone();
            async move {
                let mut row = summary(&thread);
                let Some(id) = thread["id"].as_str() else { return row };
                let page = client.request("thread/turns/list", json!({"threadId":id,"limit":1,"sortDirection":"desc","itemsView":"summary"})).await;
                if let Ok(page) = page {
                    let latest = page["data"].as_array().and_then(|turns| turns.first());
                    row["runStatus"] = json!(status(&thread["status"], latest));
                    row["latestTurnId"] = latest.map(|turn| turn["id"].clone()).unwrap_or(Value::Null);
                    if page["data"].as_array().is_some_and(Vec::is_empty)
                        && matches!(thread["status"]["type"].as_str(), Some("idle" | "notLoaded"))
                    {
                        row["runStatus"] = json!("noTasks");
                    }
                }
                // Owned live work and approvals may advance while history is being read.
                if let Some(turn) = client.active.lock().await.get(id) {
                    row["runStatus"] = json!("running");
                    row["latestTurnId"] = json!(turn);
                }
                let approvals = client.approvals.lock().await;
                for approval in approvals.values().filter(|a| a.params["threadId"] == id) {
                    let event = approval.event(client.generation);
                    if event["kind"] == "userInput" {
                        row["runStatus"] = json!("waitingInput");
                        break;
                    }
                    row["runStatus"] = json!("waitingApproval");
                }
                row
            }
        })
        .buffered(4)
        .collect()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distinguishes_runtime_flags_and_actual_completed_plans() {
        let plan = json!({"status":"completed","items":[{"type":"plan"}]});
        assert_eq!(
            status(&json!({"type":"notLoaded"}), Some(&plan)),
            "planGenerated"
        );
        assert_eq!(
            status(
                &json!({"type":"active","activeFlags":["waitingOnUserInput"]}),
                Some(&plan)
            ),
            "waitingInput"
        );
        assert_eq!(
            status(
                &json!({"type":"active","activeFlags":["waitingOnApproval"]}),
                Some(&plan)
            ),
            "waitingApproval"
        );
        assert_eq!(
            status(&json!({"type":"active","activeFlags":[]}), Some(&plan)),
            "running"
        );
        assert_eq!(
            status(
                &json!({"type":"notLoaded"}),
                Some(&json!({"status":"completed","settings":{"mode":"plan"},"items":[]}))
            ),
            "completed"
        );
        assert_eq!(status(&json!({"type":"notLoaded"}), None), "unknown");
        assert_eq!(
            status(&json!({"type":"idle"}), Some(&json!({"status":"failed"}))),
            "failed"
        );
        assert_eq!(
            status(
                &json!({"type":"idle"}),
                Some(&json!({"status":"interrupted"}))
            ),
            "interrupted"
        );
    }
}
