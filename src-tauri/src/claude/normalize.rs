use crate::codex::normalize::{prefix, OUTPUT_CAP, TEXT_CAP};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Only observable messages and tool activity are forwarded. Thinking and signatures stay native.
#[derive(Default)]
pub struct Normalizer {
    pub tools: HashMap<String, Value>,
}
impl Normalizer {
    pub fn message(&mut self, frame: &Value, thread: &str, turn: &str) -> Vec<Value> {
        let mut out = vec![];
        let role = frame["type"].as_str().unwrap_or("");
        let message = &frame["message"];
        let id = message["id"]
            .as_str()
            .or(frame["uuid"].as_str())
            .unwrap_or(turn);
        let content = &message["content"];
        if let Some(text) = content.as_str() {
            if role == "user" || role == "assistant" {
                out.push(json!({"id":id,"threadId":thread,"turnId":turn,"kind":if role=="user" {"user"} else {"message"},"title":if role=="user" {"You"} else {"Claude"},"text":prefix(text,TEXT_CAP),"truncated":text.len()>TEXT_CAP,"status":"completed"}));
            }
            return out;
        }
        for (index, block) in content.as_array().into_iter().flatten().enumerate() {
            match block["type"].as_str().unwrap_or("") {
                "text" => {
                    let text = block["text"].as_str().unwrap_or("");
                    out.push(json!({"id":format!("{id}:{index}"),"threadId":thread,"turnId":turn,"kind":if role=="user" {"user"} else {"message"},"title":if role=="user" {"You"} else {"Claude"},"text":prefix(text,TEXT_CAP),"truncated":text.len()>TEXT_CAP,"status":"completed","parentToolId":frame["parent_tool_use_id"]}));
                }
                "tool_use" => {
                    let tool_id = block["id"].as_str().unwrap_or(id);
                    let name = block["name"].as_str().unwrap_or("Tool");
                    let input = &block["input"];
                    let kind = match name {
                        "Bash" | "PowerShell" => "command",
                        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "fileChange",
                        _ => "tool",
                    };
                    let mut item = json!({"id":tool_id,"threadId":thread,"turnId":turn,"kind":kind,"title":name,"status":"inProgress","detail":prefix(&input.to_string(),20*1024),"parentToolId":frame["parent_tool_use_id"]});
                    if kind == "command" {
                        item["command"] = input["command"].clone();
                    }
                    if kind == "fileChange" {
                        item["files"] = json!([{"path":input["file_path"].as_str().or(input["notebook_path"].as_str()).unwrap_or(""),"kind":{"type":if name=="Write" {"write"} else {"update"}}}]);
                    }
                    if name == "TodoWrite" {
                        item["kind"] = json!("planProgress");
                        item["steps"]=json!(input["todos"].as_array().into_iter().flatten().take(50).map(|t|json!({"step":t["content"],"status":match t["status"].as_str(){Some("completed")=>"completed",Some("in_progress")=>"inProgress",_=>"pending"}})).collect::<Vec<_>>());
                    }
                    if self.tools.len() >= 400 {
                        self.tools.clear();
                    }
                    self.tools.insert(tool_id.into(), item.clone());
                    out.push(item);
                }
                "tool_result" => {
                    let tool_id = block["tool_use_id"].as_str().unwrap_or("");
                    if let Some(mut item) = self.tools.remove(tool_id) {
                        let text =
                            block["content"]
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| {
                                    block["content"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .filter_map(|b| b["text"].as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                });
                        item["status"] = json!(if block["is_error"] == true {
                            "failed"
                        } else {
                            "completed"
                        });
                        item["output"] = json!(prefix(&text, OUTPUT_CAP));
                        item["truncated"] = json!(text.len() > OUTPUT_CAP);
                        // Tool success is not evidence of a command's exit code.
                        if let Some(code) = frame["toolUseResult"]["exitCode"]
                            .as_i64()
                            .or(frame["tool_use_result"]["exit_code"].as_i64())
                        {
                            item["exitCode"] = json!(code);
                        }
                        out.push(item);
                    }
                }
                _ => {}
            }
        }
        out
    }
}

pub fn settings(model: Option<&str>, permission: Option<&str>) -> Value {
    json!({"model":model,"effort":null,"mode":if permission==Some("plan") {"plan"} else {"default"},"sandbox":null,"approvalPolicy":permission,"permissionProfile":null,"harness":"claude"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tools_are_observable_without_fabricated_exit_codes_or_thinking() {
        let mut n = Normalizer::default();
        let v=n.message(&json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private"},{"type":"tool_use","id":"t","name":"Bash","input":{"command":"npm test"}}]}}),"claude:a","r");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0]["command"], "npm test");
        let v=n.message(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}),"claude:a","r");
        assert_eq!(v[0]["status"], "completed");
        assert!(v[0]["exitCode"].is_null());
    }
}
