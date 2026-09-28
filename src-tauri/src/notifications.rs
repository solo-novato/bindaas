use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};

#[derive(Default)]
pub struct Notifications {
    pub enabled: AtomicBool,
    state: Mutex<NoticeState>,
}
#[derive(Default)]
struct NoticeState {
    seen: VecDeque<String>,
    titles: HashMap<String, String>,
    plans: HashMap<String, String>,
}
impl Notifications {
    // Only live events reach this path. Reading history never generates alerts.
    pub fn event(&self, name: &str, p: &Value) -> Option<(String, String)> {
        let mut state = self.state.lock().ok()?;
        let thread = p["threadId"].as_str().unwrap_or("");
        if name == "codex://thread-name" {
            if state.titles.len() >= 512 {
                state.titles.clear();
            }
            if let Some(title) = p["name"].as_str() {
                state
                    .titles
                    .insert(thread.into(), title.chars().take(200).collect());
            }
            return None;
        }
        if name == "codex://timeline-item" && p["kind"] == "plan" && p["status"] == "completed" {
            if state.plans.len() >= 512 {
                state.plans.clear();
            }
            state
                .plans
                .insert(thread.into(), p["turnId"].as_str().unwrap_or("").into());
        }
        let (id, title) = match name {
            "codex://turn-completed" => {
                let id = p["turn"]["id"].as_str()?;
                let plan = state.plans.remove(thread).is_some_and(|t| t == id);
                let title = match p["turn"]["status"].as_str()? {
                    "completed" if plan => "Codex plan is ready",
                    "completed" => "Codex finished working",
                    "failed" => "Codex task failed",
                    _ => return None,
                };
                (id, title)
            }
            "codex://approval-requested" => (
                p["requestId"].as_str()?,
                if p["kind"] == "userInput" {
                    "Codex needs your input"
                } else {
                    "Codex needs approval"
                },
            ),
            _ => return None,
        };
        let key = format!("{}:{name}:{thread}:{id}", p["generation"]);
        if state.seen.contains(&key) {
            return None;
        }
        state.seen.push_back(key);
        if state.seen.len() > 512 {
            state.seen.pop_front();
        }
        if !self.enabled.load(Ordering::SeqCst) {
            return None;
        }
        let body = state
            .titles
            .get(thread)
            .cloned()
            .unwrap_or_else(|| "Open Bindaas’s History to view the conversation.".into());
        Some((
            if p["harness"] == "claude" {
                title.replace("Codex", "Claude")
            } else {
                title.into()
            },
            body,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn live_notifications_are_opt_in_deduplicated_and_scoped() {
        let n = Notifications::default();
        let event = json!({"generation":1,"threadId":"a","turn":{"id":"one","status":"completed"}});
        assert!(n.event("codex://turn-completed", &event).is_none());
        n.enabled.store(true, Ordering::SeqCst);
        assert!(n.event("codex://turn-completed", &event).is_none());
        n.event(
            "codex://thread-name",
            &json!({"threadId":"b","name":"Fix checkout"}),
        );
        let event = json!({"generation":1,"threadId":"b","turn":{"id":"one","status":"failed"}});
        assert_eq!(
            n.event("codex://turn-completed", &event),
            Some(("Codex task failed".into(), "Fix checkout".into()))
        );
        assert!(n.event("codex://turn-completed", &event).is_none());
        assert!(n.event("codex://item", &event).is_none());
        let question = json!({"generation":1,"threadId":"b","requestId":"2","kind":"userInput"});
        assert_eq!(
            n.event("codex://approval-requested", &question).unwrap().0,
            "Codex needs your input"
        );
        assert!(n.event("codex://approval-requested", &question).is_none());
    }
    #[test]
    fn completed_plan_is_distinct_and_interruptions_stay_quiet() {
        let n = Notifications::default();
        n.enabled.store(true, Ordering::SeqCst);
        n.event(
            "codex://timeline-item",
            &json!({"threadId":"a","turnId":"one","kind":"plan","status":"completed"}),
        );
        assert_eq!(
            n.event(
                "codex://turn-completed",
                &json!({"threadId":"a","turn":{"id":"one","status":"completed"}})
            )
            .unwrap()
            .0,
            "Codex plan is ready"
        );
        assert!(n
            .event(
                "codex://turn-completed",
                &json!({"threadId":"a","turn":{"id":"two","status":"interrupted"}})
            )
            .is_none());
    }
}
