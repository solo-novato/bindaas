use serde_json::{json, Value};
pub const TEXT_CAP: usize = 128 * 1024;
pub const OUTPUT_CAP: usize = 1024 * 1024;
pub const PREVIEW_CAP: usize = 20 * 1024;
pub const DIFF_CAP: usize = 4 * 1024 * 1024;
pub fn tail(s: &str, cap: usize) -> String {
    let mut start = s.len().saturating_sub(cap);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].into()
}
pub fn prefix(s: &str, cap: usize) -> String {
    let mut end = s.len().min(cap);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].into()
}
pub fn progress(params: &Value) -> Option<Value> {
    let thread = params["threadId"].as_str()?;
    let turn = params["turnId"].as_str()?;
    let steps = params["plan"].as_array()?;
    let normalized: Vec<_> = steps
        .iter()
        .take(50)
        .filter_map(|step| {
            let text = step["step"].as_str()?;
            let status = step["status"].as_str()?;
            if !matches!(status, "pending" | "inProgress" | "completed") {
                return None;
            }
            Some(json!({"step":prefix(text, 2000),"status":status}))
        })
        .collect();
    Some(
        json!({"id":format!("turn-progress:{turn}"),"threadId":thread,"turnId":turn,"kind":"planProgress","title":"Task progress","status":"recorded","steps":normalized,"text":prefix(params["explanation"].as_str().unwrap_or(""), 4000),"truncated":steps.len()>50 || steps.iter().any(|s|s["step"].as_str().is_some_and(|s|s.len()>2000))}),
    )
}

pub fn item(item: &Value, thread: &str, turn: &str, completed: bool) -> Option<Value> {
    let kind = item["type"].as_str()?;
    let mut out = json!({"id":item["id"],"threadId":thread,"turnId":turn,"status":item["status"].as_str().unwrap_or(if completed{"completed"}else{"inProgress"})});
    let (category, title) = match kind {
        "agentMessage" => ("message", "Codex"),
        "userMessage" => ("user", "You"),
        "commandExecution" => ("command", "Command"),
        "fileChange" => ("fileChange", "File changes"),
        "plan" => ("plan", "Proposed plan"),
        "reasoning" => (
            "thinking",
            if completed {
                "Thinking summary"
            } else {
                "Thinking…"
            },
        ),
        "mcpToolCall" | "dynamicToolCall" => ("tool", "Tool call"),
        "webSearch" => ("tool", "Web search"),
        "imageView" => ("tool", "View image"),
        "contextCompaction" => ("status", "Context compacted"),
        // Unknown items and raw reasoning content are never forwarded.
        _ => return None,
    };
    out["kind"] = json!(category);
    out["title"] = json!(title);
    match kind {
        "reasoning" => {
            let summary = item["summary"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            out["text"] = json!(prefix(&summary, TEXT_CAP));
            out["truncated"] = json!(summary.len() > TEXT_CAP);
        }
        "agentMessage" | "plan" => {
            if kind == "agentMessage" {
                out["phase"] = match item["phase"].as_str() {
                    Some("commentary" | "final_answer") => item["phase"].clone(),
                    _ => Value::Null,
                };
            }
            let s = item["text"].as_str().unwrap_or("");
            out["text"] = json!(prefix(s, TEXT_CAP));
            out["truncated"] = json!(s.len() > TEXT_CAP);
        }
        "userMessage" => {
            out["clientId"] = item["clientId"].clone();
            out["text"] = json!(prefix(
                &item["content"]
                    .as_array()
                    .map(|v| v
                        .iter()
                        .filter_map(|i| i["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n"))
                    .unwrap_or_default(),
                TEXT_CAP
            ));
        }
        "commandExecution" => {
            for key in ["command", "cwd", "exitCode", "durationMs", "commandActions"] {
                out[key] = item[key].clone();
            }
            let s = item["aggregatedOutput"].as_str().unwrap_or("");
            out["output"] = json!(tail(s, PREVIEW_CAP));
            out["truncated"] = json!(s.len() > PREVIEW_CAP);
        }
        "fileChange" => {
            out["files"]=json!(item["changes"].as_array().map(|v|v.iter().take(2000).map(|c|json!({"path":c["path"],"kind":c["kind"],"diff":prefix(c["diff"].as_str().unwrap_or(""),PREVIEW_CAP)})).collect::<Vec<_>>()).unwrap_or_default());
        }
        "mcpToolCall" | "dynamicToolCall" => {
            out["title"] = item["tool"].clone();
            out["detail"]=json!(prefix(&json!({"server":item["server"],"arguments":item["arguments"],"result":item["result"],"error":item["error"]}).to_string(),PREVIEW_CAP));
        }
        _ => {}
    }
    Some(out)
}
// History has no item lifecycle flag for reasoning. Use observed Codex lifecycle
// when available; otherwise show a recorded summary without claiming live thought.
pub fn history_item(
    value: &Value,
    thread: &str,
    turn: &str,
    completed: bool,
    thinking: Option<&(String, String)>,
) -> Option<Value> {
    let mut normalized = item(value, thread, turn, completed)?;
    if value["type"] == "reasoning" && !completed {
        let running =
            thinking.is_some_and(|(t, i)| t == turn && Some(i.as_str()) == value["id"].as_str());
        normalized["status"] = json!(if running { "inProgress" } else { "recorded" });
    }
    Some(normalized)
}
pub fn turn(value: &Value) -> Value {
    json!({"id":value["id"],"status":value["status"],"error":value["error"]["message"],"startedAt":value["startedAt"],"completedAt":value["completedAt"],"durationMs":value["durationMs"]})
}

#[derive(Clone)]
pub struct Approval {
    pub id: Value,
    pub method: String,
    pub params: Value,
    pub decisions: Vec<Value>,
}
impl Approval {
    pub fn new(id: Value, method: &str, params: Value) -> Option<Self> {
        let decisions = match method {
            "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => params
                ["availableDecisions"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| {
                    vec![
                        json!("accept"),
                        json!("acceptForSession"),
                        json!("decline"),
                        json!("cancel"),
                    ]
                }),
            "item/permissions/requestApproval" => {
                vec![json!("accept"), json!("acceptForSession"), json!("decline")]
            }
            "item/tool/requestUserInput" => vec![],
            _ => return None,
        };
        Some(Self {
            id,
            method: method.into(),
            params,
            decisions,
        })
    }
    pub fn event(&self, generation: u64) -> Value {
        json!({"requestId":self.id.to_string(),"generation":generation,"kind":if self.method.contains("permissions"){"permissions"}else if self.method.contains("UserInput"){"userInput"}else if self.method.contains("fileChange"){"fileChange"}else{"command"},"threadId":self.params["threadId"],"turnId":self.params["turnId"],"itemId":self.params["itemId"],"reason":self.params["reason"],"command":self.params["command"],"cwd":self.params["cwd"],"network":self.params["networkApprovalContext"],"permissions":self.params["permissions"],"grantRoot":self.params["grantRoot"],"questions":self.params["questions"],"decisions":self.decisions})
    }
    pub fn response(&self, decision: &Value, answers: Option<&Value>) -> Result<Value, String> {
        if self.method == "item/tool/requestUserInput" {
            let answers = answers
                .and_then(Value::as_object)
                .ok_or("Answers required")?;
            let questions = self.params["questions"]
                .as_array()
                .ok_or("Invalid questions")?;
            let mut result = serde_json::Map::new();
            for q in questions {
                let id = q["id"].as_str().ok_or("Missing question id")?;
                let text = answers
                    .get(id)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty() && s.len() < 16384)
                    .ok_or("Answer each question")?;
                result.insert(id.into(), json!({"answers":[text]}));
            }
            return Ok(json!({"answers":result}));
        }
        if !self.decisions.contains(decision) {
            return Err("Decision is not offered by this approval".into());
        }
        if self.method == "item/permissions/requestApproval" {
            let permissions = if decision == "decline" {
                json!({})
            } else {
                let mut p = self.params["permissions"].clone();
                if let Some(m) = p.as_object_mut() {
                    m.retain(|_, v| !v.is_null());
                }
                p
            };
            Ok(
                json!({"permissions":permissions,"scope":if decision=="acceptForSession"{"session"}else{"turn"}}),
            )
        } else {
            Ok(json!({"decision":decision}))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exposes_reasoning_summaries_and_caps_utf8() {
        let value = item(&json!({"type":"reasoning","summary":["Checking dependencies"],"content":["NEVER_RENDER_THIS"]}), "t", "r", false).unwrap();
        assert_eq!(value["kind"], "thinking");
        assert_eq!(value["text"], "Checking dependencies");
        assert!(!value.to_string().contains("NEVER_RENDER_THIS"));
        assert_eq!(tail("a🦀b", 3), "b");
    }
    #[test]
    fn preserves_user_message_client_id_for_steering_receipts() {
        let value = item(&json!({"type":"userMessage","id":"server-id","clientId":"client-id","content":[{"type":"text","text":"Focus on tests"}]}), "t", "r", true).unwrap();
        assert_eq!(value["clientId"], "client-id");
        assert_eq!(value["id"], "server-id");
        assert_eq!(value["text"], "Focus on tests");
    }
    #[test]
    fn message_phase_is_reported_not_inferred() {
        for phase in [
            json!("final_answer"),
            json!("commentary"),
            Value::Null,
            json!("future_phase"),
        ] {
            let value = item(
                &json!({"type":"agentMessage","id":"m","text":"Done","phase":phase}),
                "t",
                "r",
                true,
            )
            .unwrap();
            assert_eq!(
                value["phase"],
                if phase == "final_answer" || phase == "commentary" {
                    phase
                } else {
                    Value::Null
                }
            );
        }
        let value = item(
            &json!({"type":"agentMessage","id":"m","text":"All done"}),
            "t",
            "r",
            true,
        )
        .unwrap();
        assert!(value["phase"].is_null());
    }
    #[test]
    fn approval_validates_options() {
        let a = Approval::new(
            json!(4),
            "item/commandExecution/requestApproval",
            json!({"availableDecisions":["decline"]}),
        )
        .unwrap();
        assert!(a.response(&json!("accept"), None).is_err());
        assert_eq!(
            a.response(&json!("decline"), None).unwrap(),
            json!({"decision":"decline"})
        );
    }
}
