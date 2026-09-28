use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Default,
    Plan,
}

pub fn turn_params(
    thread: &str,
    prompt: &str,
    attachments: Vec<Value>,
    mode: Mode,
    model: &str,
    effort: Option<&str>,
) -> Value {
    turn_overrides(thread, prompt, attachments, Some(mode), Some(model), effort)
}

pub fn turn_overrides(
    thread: &str,
    prompt: &str,
    attachments: Vec<Value>,
    mode: Option<Mode>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Value {
    let mut input = vec![];
    if !prompt.trim().is_empty() {
        input.push(json!({"type":"text","text":prompt,"text_elements":[]}));
    }
    input.extend(attachments);
    // Request readable summaries explicitly: model catalogs may default to none.
    // This controls summary delivery, not effort, model, collaboration, or permissions.
    let mut params = json!({"threadId":thread,"input":input,"summary":"auto"});
    if let Some(mode) = mode {
        params["collaborationMode"] = json!({"mode":mode,"settings":{"model":model,"reasoning_effort":effort,"developer_instructions":null}});
    } else {
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        if let Some(effort) = effort {
            params["effort"] = json!(effort);
        }
    }
    params
}
