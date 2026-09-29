//! One project per window. Every window shares the same Codex process, so this
//! registry remembers which project each window shows and which project each
//! conversation belongs to. Agent events for a conversation reach only the window
//! showing its project; app-wide events (connection, sign-in) reach every window.
use crate::AppState;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

#[derive(Default)]
pub struct Windows {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Window label → the project it shows.
    projects: HashMap<String, PathBuf>,
    /// Window label → the project it will open once it has loaded.
    pending: HashMap<String, PathBuf>,
    /// Qualified conversation ID (`codex:…`, `claude:…`) → its project.
    threads: HashMap<String, PathBuf>,
    /// Window label → conversations waiting on the user there.
    attention: HashMap<String, u32>,
    /// Windows that still have to agree to quit, in order.
    quitting: Option<Vec<String>>,
    next: u32,
}

/// Where an event goes.
#[derive(Debug, PartialEq)]
pub enum Route {
    /// No conversation, or one this app has not seen: every window.
    All,
    /// These windows (possibly none, when no window shows the project).
    To(Vec<String>),
    /// A batch whose entries belong to different windows.
    Split(Vec<(Route, Value)>),
}

impl Windows {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn project(&self, label: &str) -> Option<PathBuf> {
        self.lock().projects.get(label).cloned()
    }

    pub fn set_project(&self, label: &str, root: Option<PathBuf>) {
        let mut inner = self.lock();
        inner.pending.remove(label);
        match root {
            Some(root) => inner.projects.insert(label.into(), root),
            None => inner.projects.remove(label),
        };
    }

    /// Another window that shows (or is about to open) `root`.
    pub fn showing(&self, root: &Path, except: &str) -> Option<String> {
        let inner = self.lock();
        inner
            .projects
            .iter()
            .chain(inner.pending.iter())
            .find(|(label, r)| label.as_str() != except && r.as_path() == root)
            .map(|(label, _)| label.clone())
    }

    /// Projects shown in windows other than `except`.
    pub fn others(&self, except: &str) -> Vec<PathBuf> {
        let inner = self.lock();
        inner
            .projects
            .iter()
            .filter(|(label, _)| label.as_str() != except)
            .map(|(_, root)| root.clone())
            .collect()
    }

    /// Reserves a label for a new window that will open `project` when it loads.
    pub fn reserve(&self, project: Option<PathBuf>) -> String {
        let mut inner = self.lock();
        inner.next += 1;
        let label = format!("project-{}", inner.next);
        if let Some(root) = project {
            inner.pending.insert(label.clone(), root);
        }
        label
    }

    pub fn set_pending(&self, label: &str, root: PathBuf) {
        self.lock().pending.insert(label.into(), root);
    }

    /// The project a window should open first, if one was chosen for it.
    pub fn take_pending(&self, label: &str) -> Option<PathBuf> {
        self.lock().pending.remove(label)
    }

    /// Forgets a closed window. Returns the new attention total.
    pub fn remove(&self, label: &str) -> u32 {
        let mut inner = self.lock();
        inner.projects.remove(label);
        inner.pending.remove(label);
        inner.attention.remove(label);
        if let Some(queue) = &mut inner.quitting {
            queue.retain(|l| l != label);
        }
        inner.attention.values().sum()
    }

    /// Records that a conversation belongs to `root`.
    pub fn claim(&self, thread: &str, root: &Path) {
        self.lock().threads.insert(thread.into(), root.into());
    }

    /// Whether a conversation may be shown in a window showing `root`. Conversations
    /// this app has not seen yet stay visible, as they did before windows existed.
    pub fn visible(&self, thread: &str, root: Option<&Path>) -> bool {
        match self.lock().threads.get(thread) {
            Some(owner) => Some(owner.as_path()) == root,
            None => true,
        }
    }

    pub fn set_attention(&self, label: &str, count: u32) -> u32 {
        let mut inner = self.lock();
        inner.attention.insert(label.into(), count);
        inner.attention.values().sum()
    }

    pub fn route(&self, payload: &Value) -> Route {
        if let Value::Array(entries) = payload {
            let mut groups: Vec<(Route, Vec<Value>)> = vec![];
            for entry in entries {
                let route = self.route(entry);
                match groups.iter_mut().find(|(r, _)| *r == route) {
                    Some((_, list)) => list.push(entry.clone()),
                    None => groups.push((route, vec![entry.clone()])),
                }
            }
            return match groups.len() {
                0 => Route::All,
                1 => groups.pop().map(|(route, _)| route).unwrap_or(Route::All),
                _ => Route::Split(
                    groups
                        .into_iter()
                        .map(|(route, list)| (route, Value::Array(list)))
                        .collect(),
                ),
            };
        }
        let thread = payload["threadId"].as_str();
        let mut inner = self.lock();
        let known = thread.and_then(|id| inner.threads.get(id).cloned());
        let root = match (known, payload["projectRoot"].as_str()) {
            (Some(root), _) => root,
            (None, Some(root)) => {
                // A conversation Codex just started: learn where it lives.
                let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.into());
                if let Some(id) = thread {
                    inner.threads.insert(id.into(), root.clone());
                }
                root
            }
            (None, None) => return Route::All,
        };
        let mut labels: Vec<String> = inner
            .projects
            .iter()
            .filter(|(_, r)| **r == root)
            .map(|(label, _)| label.clone())
            .collect();
        labels.sort();
        Route::To(labels)
    }

    /// Starts asking each window in turn whether it may quit and returns the window
    /// to ask. Asked again while a quit is pending (⌘Q twice), it returns the window
    /// still being waited on, in case that window was loading and missed the request.
    pub fn begin_quit(&self, mut labels: Vec<String>) -> Option<String> {
        let mut inner = self.lock();
        if let Some(queue) = &inner.quitting {
            return queue.first().cloned();
        }
        labels.dedup();
        let first = labels.first().cloned();
        inner.quitting = Some(labels);
        first
    }

    /// A window answered. Returns the next window to ask; None with `done` set when
    /// every window agreed; None without it when a window declined or no quit runs.
    pub fn answer_quit(&self, label: &str, approved: bool) -> (Option<String>, bool) {
        let mut inner = self.lock();
        let Some(queue) = &mut inner.quitting else {
            return (None, false);
        };
        if !approved {
            inner.quitting = None;
            return (None, false);
        }
        queue.retain(|l| l != label);
        match queue.first().cloned() {
            Some(next) => (Some(next), false),
            None => {
                inner.quitting = None;
                (None, true)
            }
        }
    }

    /// The window a quit is waiting on, if any.
    pub fn quit_waiting_on(&self) -> Option<String> {
        self.lock()
            .quitting
            .as_ref()
            .and_then(|q| q.first().cloned())
    }
}

// ---- Tauri glue ----------------------------------------------------------------

fn labelled(target: &EventTarget) -> Option<&str> {
    match target {
        EventTarget::WebviewWindow { label }
        | EventTarget::Window { label }
        | EventTarget::Webview { label }
        | EventTarget::AnyLabel { label } => Some(label),
        _ => None,
    }
}

/// Sends an event to specific windows. Each window listens for events addressed to
/// it, so a filtered emit never reaches the others.
pub fn emit_to(app: &AppHandle, labels: &[String], name: &str, payload: Value) {
    if labels.is_empty() {
        return;
    }
    let _ = app.emit_filter(name, payload, |target| {
        labelled(target).is_some_and(|label| labels.iter().any(|l| l == label))
    });
}

/// Sends an event to every window except `sender`.
pub fn emit_others(app: &AppHandle, sender: &str, name: &str, payload: Value) {
    let _ = app.emit_filter(name, payload, |target| {
        labelled(target).is_some_and(|label| label != sender)
    });
}

/// Delivers an agent event to the windows it belongs to.
pub fn deliver(app: &AppHandle, windows: &Windows, name: &str, payload: Value) {
    match windows.route(&payload) {
        Route::All => {
            let _ = app.emit(name, payload);
        }
        Route::To(labels) => emit_to(app, &labels, name, payload),
        Route::Split(parts) => {
            for (route, part) in parts {
                match route {
                    Route::To(labels) => emit_to(app, &labels, name, part),
                    _ => {
                        let _ = app.emit(name, part);
                    }
                }
            }
        }
    }
}

pub fn focus(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn front(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Opens `project` in a new window, or brings forward the window already showing it.
/// Without a project the new window starts on the welcome screen.
pub fn open(app: &AppHandle, project: Option<PathBuf>) -> Result<String, String> {
    let state = app.state::<AppState>();
    if let Some(root) = &project {
        if let Some(label) = state.windows.showing(root, "") {
            focus(app, &label);
            return Ok(label);
        }
    }
    let label = state.windows.reserve(project);
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("Missing window configuration")?;
    config.label = label.clone();
    // Cascade from the window in front so the new one is visibly separate.
    if let Some(w) = front(app) {
        if let (Ok(scale), Ok(position)) = (w.scale_factor(), w.outer_position()) {
            let position = position.to_logical::<f64>(scale);
            config.x = Some(position.x + 28.0);
            config.y = Some(position.y + 28.0);
            config.center = false;
        }
    }
    let built = tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build());
    if let Err(e) = built {
        state.windows.remove(&label);
        return Err(format!("Could not open a new window: {e}"));
    }
    Ok(label)
}

/// The dock badge shows conversations waiting on you across all windows.
pub fn set_badge(app: &AppHandle, total: u32) {
    if let Some(w) = app.webview_windows().into_values().next() {
        let _ = w.set_badge_count((total > 0).then_some(i64::from(total)));
    }
}

fn ask_quit(app: &AppHandle, label: &str) {
    focus(app, label);
    emit_to(
        app,
        &[label.to_string()],
        "workbench://quit-requested",
        Value::Null,
    );
}

/// Quitting asks each window in turn (front window first) to confirm its own running
/// tasks and unsaved files. Any window can cancel.
pub fn request_quit(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    labels.sort();
    if let Some(w) = front(app) {
        labels.retain(|l| l != w.label());
        labels.insert(0, w.label().to_string());
    }
    match state.windows.begin_quit(labels) {
        Some(label) => ask_quit(app, &label),
        None => finish_quit(app),
    }
}

pub fn answer_quit(app: &AppHandle, label: &str, approved: bool) {
    let state = app.state::<AppState>();
    match state.windows.answer_quit(label, approved) {
        (Some(next), _) => ask_quit(app, &next),
        (None, true) => finish_quit(app),
        (None, false) => {}
    }
}

fn finish_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        crate::commands::stop_agents(&state).await;
        state.quit_confirmed.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// A window is gone (closed, or destroyed while quitting).
pub fn closed(app: &AppHandle, label: &str) {
    let state = app.state::<AppState>();
    let waited_on = state.windows.quit_waiting_on().as_deref() == Some(label);
    if waited_on {
        answer_quit(app, label, true);
    }
    let total = state.windows.remove(label);
    set_badge(app, total);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn two_projects() -> Windows {
        let w = Windows::default();
        w.set_project("main", Some("/work/app".into()));
        w.set_project("project-1", Some("/work/api".into()));
        w
    }

    #[test]
    fn conversation_events_reach_only_their_project_window() {
        let w = two_projects();
        w.claim("codex:a", Path::new("/work/app"));
        w.claim("claude:b", Path::new("/work/api"));
        assert_eq!(
            w.route(&json!({"threadId":"codex:a"})),
            Route::To(vec!["main".into()])
        );
        assert_eq!(
            w.route(&json!({"threadId":"claude:b"})),
            Route::To(vec!["project-1".into()])
        );
        assert_eq!(w.route(&json!({"type":"ready"})), Route::All);
        assert_eq!(w.route(&json!({"threadId":"codex:unseen"})), Route::All);
        w.set_project("project-1", None);
        assert_eq!(w.route(&json!({"threadId":"claude:b"})), Route::To(vec![]));
    }

    #[test]
    fn new_conversations_are_learned_from_their_project_root() {
        let w = two_projects();
        assert_eq!(
            w.route(&json!({"threadId":"codex:new","projectRoot":"/work/api"})),
            Route::To(vec!["project-1".into()])
        );
        assert_eq!(
            w.route(&json!({"threadId":"codex:new"})),
            Route::To(vec!["project-1".into()])
        );
        assert!(!w.visible("codex:new", Some(Path::new("/work/app"))));
        assert!(w.visible("codex:new", Some(Path::new("/work/api"))));
        assert!(w.visible("codex:other", Some(Path::new("/work/app"))));
    }

    #[test]
    fn streamed_batches_split_by_window() {
        let w = two_projects();
        w.claim("codex:a", Path::new("/work/app"));
        w.claim("codex:b", Path::new("/work/api"));
        let batch = json!([{"threadId":"codex:a","delta":"1"},{"threadId":"codex:b","delta":"2"},{"threadId":"codex:a","delta":"3"}]);
        let Route::Split(parts) = w.route(&batch) else {
            panic!("expected a split batch");
        };
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, Route::To(vec!["main".into()]));
        assert_eq!(parts[0].1.as_array().unwrap().len(), 2);
        assert_eq!(parts[1].0, Route::To(vec!["project-1".into()]));
        let single = json!([{"threadId":"codex:a"}]);
        assert_eq!(w.route(&single), Route::To(vec!["main".into()]));
    }

    #[test]
    fn a_project_is_shown_once_and_pending_windows_count() {
        let w = two_projects();
        assert_eq!(
            w.showing(Path::new("/work/api"), "main"),
            Some("project-1".into())
        );
        assert_eq!(w.showing(Path::new("/work/api"), "project-1"), None);
        let label = w.reserve(Some("/work/blog".into()));
        assert_eq!(
            w.showing(Path::new("/work/blog"), "main"),
            Some(label.clone())
        );
        assert_eq!(w.take_pending(&label), Some(PathBuf::from("/work/blog")));
        assert_eq!(w.take_pending(&label), None);
        assert_ne!(w.reserve(None), label);
        assert_eq!(w.others("main"), vec![PathBuf::from("/work/api")]);
    }

    #[test]
    fn dock_attention_sums_windows_and_forgets_closed_ones() {
        let w = two_projects();
        assert_eq!(w.set_attention("main", 2), 2);
        assert_eq!(w.set_attention("project-1", 1), 3);
        assert_eq!(w.set_attention("main", 0), 1);
        assert_eq!(w.remove("project-1"), 0);
    }

    #[test]
    fn quitting_asks_each_window_once_and_any_window_can_cancel() {
        let w = two_projects();
        assert_eq!(
            w.begin_quit(vec!["project-1".into(), "main".into()]),
            Some("project-1".into())
        );
        // A second request re-asks the same window rather than starting over.
        assert_eq!(w.begin_quit(vec!["main".into()]), Some("project-1".into()));
        assert_eq!(
            w.answer_quit("project-1", true),
            (Some("main".into()), false)
        );
        assert_eq!(w.answer_quit("main", true), (None, true));
        assert_eq!(w.quit_waiting_on(), None);
        w.begin_quit(vec!["main".into(), "project-1".into()]);
        assert_eq!(w.answer_quit("main", false), (None, false));
        assert_eq!(w.quit_waiting_on(), None);
        w.begin_quit(vec!["main".into(), "project-1".into()]);
        w.remove("main");
        assert_eq!(w.quit_waiting_on(), Some("project-1".into()));
    }
}
