//! Typed Bindaas operations. Native protocols and credentials never cross this boundary.
use crate::{claude, codex, commands, settings, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::State;
use tokio::sync::Mutex;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Harness {
    #[default]
    Codex,
    Claude,
}
pub struct Registry {
    pub codex: Arc<Mutex<codex::Manager>>,
    pub claude: Mutex<claude::Manager>,
}
pub fn harness(id: &str) -> Harness {
    if id.starts_with("claude:") {
        Harness::Claude
    } else {
        Harness::Codex
    }
}
pub fn native(id: &str) -> String {
    id.strip_prefix("codex:")
        .or_else(|| id.strip_prefix("claude:"))
        .unwrap_or(id)
        .into()
}
pub fn codex_key(id: &str) -> String {
    if id.starts_with("codex:") || id.starts_with("claude:") {
        id.into()
    } else {
        format!("codex:{id}")
    }
}
pub fn qualify(mut v: Value) -> Value {
    match &mut v {
        Value::Array(a) => {
            for item in a {
                *item = qualify(item.take())
            }
        }
        Value::Object(o) => {
            if o.contains_key("cwd") && (o.contains_key("preview") || o.contains_key("createdAt")) {
                if let Some(id) = o.get("id").and_then(Value::as_str) {
                    let id = codex_key(id);
                    o.insert("id".into(), json!(id));
                    o.insert("harness".into(), json!("codex"));
                }
            }
            for key in ["threadId", "lastThreadId"] {
                if let Some(id) = o.get(key).and_then(Value::as_str) {
                    let id = codex_key(id);
                    o.insert(key.into(), json!(id));
                }
            }
            if let Some(Value::Object(map)) = o.get_mut("activeThreads") {
                *map = std::mem::take(map)
                    .into_iter()
                    .map(|(k, v)| (codex_key(&k), v))
                    .collect();
            }
            if let Some(Value::Array(ids)) = o.get_mut("waitingThreads") {
                for id in ids {
                    if let Some(s) = id.as_str() {
                        *id = json!(codex_key(s))
                    }
                }
            }
            if let Some(Value::Array(pair)) = o.get_mut("active") {
                if let Some(id) = pair.first().and_then(Value::as_str) {
                    let id = codex_key(id);
                    pair[0] = json!(id);
                }
            }
            for value in o.values_mut() {
                if value.is_object() || value.is_array() {
                    *value = qualify(value.take())
                }
            }
        }
        _ => {}
    }
    v
}
pub fn codex_sink(sink: codex::Sink) -> codex::Sink {
    Arc::new(move |name, payload| {
        let mut payload = qualify(payload);
        if let Some(o) = payload.as_object_mut() {
            o.insert("harness".into(), json!("codex"));
        }
        sink(&name.replacen("codex://", "agent://", 1), payload);
    })
}
async fn root(s: &AppState) -> Result<PathBuf, String> {
    s.project
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Open a project first".into())
}
async fn claude_client(s: &AppState, id: Option<&str>) -> Result<Arc<claude::Client>, String> {
    let root = root(s).await?;
    let settings = s.settings.lock().await.clone();
    if !settings.claude_enabled {
        return Err("Connect Claude Code in Settings → Integrations first.".into());
    }
    let exe = claude::discover(settings.claude_executable_path.as_deref())?;
    s.agents
        .claude
        .lock()
        .await
        .get(&root, id, &exe, settings.codex_idle_timeout_seconds)
        .await
}
async fn existing(s: &AppState, id: &str) -> Result<Arc<claude::Client>, String> {
    let root = root(s).await?;
    let c = s
        .agents
        .claude
        .lock()
        .await
        .existing(id)
        .ok_or("Claude is not connected to this conversation")?;
    if c.root != root {
        return Err("Conversation belongs to another project".into());
    }
    Ok(c)
}
async fn claude_history(s: &AppState, id: &str) -> Result<(Value, Vec<Value>), String> {
    let root = root(s).await?;
    let session = native(id);
    let history = tokio::task::spawn_blocking(move || {
        claude::history::read(&claude::history::config_dir(), &root, &session)
    })
    .await
    .map_err(|e| e.to_string())?;
    let live = existing(s, id).await.ok();
    let (summary, mut turns) = match history {
        Ok(h) => h,
        Err(e) => {
            if let Some(c) = &live {
                let r = c.runtime.lock().await;
                (
                    json!({"id":id,"harness":"claude","name":null,"preview":r.title,"cwd":c.root,"createdAt":0,"updatedAt":0,"status":{"type":"notLoaded"},"runStatus":"unknown"}),
                    vec![],
                )
            } else {
                return Err(e);
            }
        }
    };
    if let Some(c) = live {
        let r = c.runtime.lock().await;
        for t in r.turns.iter().rev() {
            turns.retain(|v| v["id"] != t["id"]);
            turns.insert(0, t.clone());
        }
        if let Some(t) = &r.turn {
            turns.retain(|v| v["id"] != t["id"]);
            let mut t = t.clone();
            t["items"] = json!(r.items);
            turns.insert(0, t);
        }
    }
    Ok((summary, turns))
}
fn public_approval(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("nativeInput");
        o.remove("nativeRequestId");
    }
    v
}
fn page(data: Vec<Value>, cursor: Option<String>, limit: usize) -> Result<Value, String> {
    let offset = cursor
        .as_deref()
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "Invalid history cursor")?;
    Ok(
        json!({"data":data.iter().skip(offset).take(limit).collect::<Vec<_>>(),"nextCursor":if offset.saturating_add(limit)<data.len(){Some((offset+limit).to_string())}else{None}}),
    )
}

#[tauri::command]
pub async fn agent_connect_claude(
    s: State<'_, AppState>,
    executable: Option<String>,
) -> Result<Value, String> {
    let exe = claude::discover(executable.as_deref())?;
    let status = claude::probe(&exe).await?;
    if status["authenticated"] == true {
        let _op = s.operations.lock().await;
        // An initialize handshake verifies the CLI protocol without starting a model turn.
        let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
        let mut manager = s.agents.claude.lock().await;
        manager.next += 1;
        let c = claude::Client::spawn(
            &exe,
            tmp.path(),
            &claude::uuid(),
            false,
            manager.next,
            Arc::new(|_, _| {}),
            30,
        )
        .await?;
        let catalog = c.initialization.lock().await.clone();
        c.shutdown(false).await?;
        manager.catalog = Some(catalog);
        drop(manager);
        let mut saved = s.settings.lock().await;
        let mut next = saved.clone();
        next.claude_enabled = true;
        next.claude_executable_path = executable;
        settings::save(&s.settings_path, &next)?;
        *saved = next;
    }
    Ok(status)
}
#[tauri::command]
pub async fn agent_disconnect_claude(s: State<'_, AppState>) -> Result<(), String> {
    let _op = s.operations.lock().await;
    s.agents.claude.lock().await.shutdown(false).await?;
    let mut saved = s.settings.lock().await;
    saved.claude_enabled = false;
    settings::save(&s.settings_path, &saved)
}
#[tauri::command]
pub async fn agent_get_state(
    s: State<'_, AppState>,
    harness: Option<Harness>,
    thread_id: Option<String>,
) -> Result<Value, String> {
    if harness != Some(Harness::Claude) {
        return commands::codex_get_state(s).await.map(qualify);
    }
    if let Some(id) = thread_id {
        if let Ok(c) = existing(&s, &id).await {
            let r = c.runtime.lock().await;
            return Ok(
                json!({"type":if c.alive.load(Ordering::SeqCst){"ready"}else{"sleeping"},"harness":"claude","threadId":id,"generation":c.generation,"activeThreads":r.turn.as_ref().filter(|t|t["status"]=="inProgress").map(|t|json!({id.clone():t["id"]})).unwrap_or(json!({})),"approvals":r.approvals.len()}),
            );
        }
    }
    Ok(json!({"type":"sleeping","harness":"claude"}))
}
#[tauri::command]
pub async fn agent_get_models(
    s: State<'_, AppState>,
    harness: Option<Harness>,
) -> Result<Value, String> {
    if harness != Some(Harness::Claude) {
        return commands::codex_get_models(s).await;
    }
    let settings = s.settings.lock().await.clone();
    if !settings.claude_enabled {
        return Err("Connect Claude Code in Integrations first".into());
    }
    let mut manager = s.agents.claude.lock().await;
    if manager.catalog.is_none() {
        let exe = claude::discover(settings.claude_executable_path.as_deref())?;
        let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
        manager.next += 1;
        let c = claude::Client::spawn(
            &exe,
            tmp.path(),
            &claude::uuid(),
            false,
            manager.next,
            Arc::new(|_, _| {}),
            30,
        )
        .await?;
        manager.catalog = Some(c.initialization.lock().await.clone());
        c.shutdown(false).await?;
    }
    let init = manager.catalog.as_ref().unwrap();
    let models:Vec<_>=init["models"].as_array().into_iter().flatten().enumerate().map(|(i,m)|json!({"id":m["value"],"model":m["value"],"displayName":m["displayName"],"isDefault":i==0,"supportedReasoningEfforts":[],"defaultReasoningEffort":""})).collect();
    // CLI default remains selectable even when this version doesn't enumerate models.
    Ok(if models.is_empty() {
        json!([{"id":"default","model":"default","displayName":"Claude default","isDefault":true,"supportedReasoningEfforts":[],"defaultReasoningEffort":""}])
    } else {
        json!(models)
    })
}
#[tauri::command]
pub async fn agent_get_account(
    s: State<'_, AppState>,
    harness: Option<Harness>,
) -> Result<Value, String> {
    if harness != Some(Harness::Claude) {
        return commands::codex_get_account(s).await;
    }
    let exe = claude::discover(s.settings.lock().await.claude_executable_path.as_deref())?;
    let v = claude::probe(&exe).await?;
    Ok(
        json!({"account":if v["authenticated"]==true{json!({"type":v["authMethod"]})}else{Value::Null},"requiresOpenaiAuth":true}),
    )
}
#[tauri::command]
pub async fn agent_list_threads(
    s: State<'_, AppState>,
    cursor: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let settings = s.settings.lock().await.clone();
    if !settings.claude_enabled {
        return commands::codex_list_threads(s, cursor, archived)
            .await
            .map(qualify);
    }
    let cursors: Value = cursor
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|_| "Invalid conversation cursor")?
        .unwrap_or(json!({}));
    let c = if cursors["codexDone"] == true {
        Ok(json!({"data":[],"nextCursor":null}))
    } else {
        commands::codex_list_threads(
            s.clone(),
            cursors["codex"].as_str().map(str::to_owned),
            archived,
        )
        .await
        .map(qualify)
    };
    let root = root(&s).await?;
    let rows = tokio::task::spawn_blocking(move || {
        claude::history::list(&claude::history::config_dir(), &root)
    })
    .await
    .map_err(|e| e.to_string())?;
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|t| {
            settings
                .claude_archived
                .iter()
                .any(|id| id == t["id"].as_str().unwrap_or(""))
                == archived.unwrap_or(false)
        })
        .map(|mut t| {
            if let Some(title) = settings.claude_titles.get(t["id"].as_str().unwrap_or("")) {
                t["name"] = json!(title)
            }
            t
        })
        .collect();
    let cp = if cursors["claudeDone"] == true {
        json!({"data":[],"nextCursor":null})
    } else {
        page(rows, cursors["claude"].as_str().map(str::to_owned), 30)?
    };
    let error = c.as_ref().err().cloned();
    let c = c.unwrap_or(json!({"data":[],"nextCursor":null}));
    let mut rows = c["data"].as_array().cloned().unwrap_or_default();
    rows.extend(cp["data"].as_array().cloned().unwrap_or_default());
    for t in &mut rows {
        if t["harness"] == "claude" {
            if let Ok(client) = existing(&s, t["id"].as_str().unwrap_or("")).await {
                let r = client.runtime.lock().await;
                if let Some(turn) = &r.turn {
                    t["runStatus"] = json!(if !r.approvals.is_empty() {
                        "waitingInput"
                    } else if turn["status"] == "inProgress" {
                        "running"
                    } else {
                        turn["status"].as_str().unwrap_or("unknown")
                    });
                }
            }
        }
    }
    rows.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    let next = if c["nextCursor"].is_null() && cp["nextCursor"].is_null() {
        Value::Null
    } else {
        json!(json!({"codex":c["nextCursor"],"codexDone":c["nextCursor"].is_null(),"claude":cp["nextCursor"],"claudeDone":cp["nextCursor"].is_null()}).to_string())
    };
    Ok(json!({"data":rows,"nextCursor":next,"warning":error}))
}
#[tauri::command]
pub async fn agent_resume_thread(
    s: State<'_, AppState>,
    thread_id: String,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_resume_thread(s, native(&thread_id))
            .await
            .map(qualify);
    }
    let (mut thread, turns) = claude_history(&s, &thread_id).await?;
    let mut settings = turns
        .first()
        .map(|t| t["settings"].clone())
        .unwrap_or_else(|| claude::normalize::settings(None, None));
    let mut approvals = vec![];
    if let Ok(c) = existing(&s, &thread_id).await {
        let r = c.runtime.lock().await;
        settings = r.settings.clone();
        approvals = r.approvals.values().cloned().map(public_approval).collect();
    }
    let mut saved = s.settings.lock().await;
    if let Some(title) = saved.claude_titles.get(&thread_id) {
        thread["name"] = json!(title);
    }
    saved
        .project_state
        .insert(root(&s).await?.to_string_lossy().into_owned(), thread_id);
    settings::save(&s.settings_path, &saved)?;
    Ok(json!({"thread":thread,"settings":settings,"approvals":approvals}))
}
#[tauri::command]
pub async fn agent_thread_turns(
    s: State<'_, AppState>,
    thread_id: String,
    cursor: Option<String>,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_thread_turns(s, native(&thread_id), cursor)
            .await
            .map(qualify);
    }
    let (summary, turns) = claude_history(&s, &thread_id).await?;
    let mut result = page(turns, cursor, 30)?;
    if summary["historyTruncated"] == true {
        result["warning"]=json!("Showing the most recent 32 MiB of native history. Older messages remain available in Claude Code.");
    }
    Ok(result)
}
#[tauri::command]
pub async fn agent_turn_items(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    cursor: Option<String>,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_turn_items(s, native(&thread_id), turn_id, cursor)
            .await
            .map(qualify);
    }
    let (_, turns) = claude_history(&s, &thread_id).await?;
    let items = turns
        .iter()
        .find(|t| t["id"] == turn_id)
        .and_then(|t| t["items"].as_array())
        .cloned()
        .unwrap_or_default();
    page(items, cursor, 100)
}
// Tauri commands receive each IPC argument as a parameter.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_start_turn(
    s: State<'_, AppState>,
    harness: Option<Harness>,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<codex::input::Mode>,
    attachment_ids: Option<Vec<String>>,
    permissions: Option<String>,
    approval_policy: Option<String>,
) -> Result<Value, String> {
    let selected = thread_id
        .as_deref()
        .map(self::harness)
        .unwrap_or(harness.unwrap_or_default());
    if selected == Harness::Codex {
        return commands::codex_start_turn(
            s,
            thread_id.map(|id| native(&id)),
            prompt,
            model,
            effort,
            mode,
            attachment_ids,
            permissions,
            approval_policy,
        )
        .await
        .map(qualify);
    }
    let _op = s.operations.lock().await;
    let attachments = s
        .attachments
        .lock()
        .map_err(|e| e.to_string())?
        .claude_input(&attachment_ids.unwrap_or_default())?;
    let c = claude_client(&s, thread_id.as_deref()).await?;
    c.emit(
        "baseline",
        json!({"git":crate::git::snapshot(&root(&s).await?).await}),
    );
    let mode = mode.map(|m| match m {
        codex::input::Mode::Plan => "plan",
        _ => "default",
    });
    let result = c
        .start(
            &prompt,
            attachments,
            model.as_deref().filter(|m| *m != "default"),
            mode,
        )
        .await?;
    let mut saved = s.settings.lock().await;
    saved
        .project_state
        .insert(c.root.to_string_lossy().into_owned(), c.thread());
    settings::save(&s.settings_path, &saved)?;
    Ok(result)
}
#[tauri::command]
pub async fn agent_interrupt_turn(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_interrupt_turn(s, native(&thread_id), turn_id).await;
    }
    existing(&s, &thread_id).await?.interrupt(&turn_id).await
}
#[tauri::command]
pub async fn agent_respond_server_request(
    s: State<'_, AppState>,
    generation: u64,
    request_id: String,
    decision: Value,
    answers: Option<Value>,
    thread_id: Option<String>,
) -> Result<(), String> {
    if request_id.starts_with("claude:") {
        let id = thread_id.ok_or("Missing approval conversation")?;
        return existing(&s, &id)
            .await?
            .respond(generation, &request_id, &decision, answers)
            .await;
    }
    if thread_id
        .as_deref()
        .is_some_and(|id| self::harness(id) != Harness::Codex)
    {
        return Err("Approval belongs to another agent".into());
    }
    let id = thread_id.ok_or("Missing approval conversation")?;
    let manager = s.agents.codex.lock().await;
    let client = manager
        .client
        .as_ref()
        .ok_or("Approval connection no longer exists")?;
    {
        let requests = client.approvals.lock().await;
        let request = requests
            .get(&request_id)
            .ok_or("Request has already been resolved")?;
        if request.params["threadId"].as_str() != Some(native(&id).as_str()) {
            return Err("Approval belongs to another conversation".into());
        }
    }
    client
        .respond(generation, &request_id, decision, answers)
        .await
}
#[tauri::command]
pub async fn agent_update_thread_settings(
    s: State<'_, AppState>,
    thread_id: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<codex::input::Mode>,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_update_thread_settings(s, native(&thread_id), model, effort, mode)
            .await;
    }
    let _op = s.operations.lock().await;
    if effort.is_some() {
        return Err("Reasoning effort is not exposed by the connected Claude CLI".into());
    }
    let c = claude_client(&s, Some(&thread_id)).await?;
    c.update(
        model.as_deref(),
        mode.map(|m| match m {
            codex::input::Mode::Plan => "plan",
            _ => "default",
        }),
    )
    .await
}
#[tauri::command]
pub async fn agent_session_status(
    s: State<'_, AppState>,
    thread_id: Option<String>,
    harness: Option<Harness>,
) -> Result<Value, String> {
    if thread_id
        .as_deref()
        .map(self::harness)
        .unwrap_or(harness.unwrap_or_default())
        == Harness::Codex
    {
        return commands::codex_session_status(s, thread_id.map(|s| native(&s)))
            .await
            .map(qualify);
    }
    if let Some(id) = thread_id {
        if let Ok(c) = existing(&s, &id).await {
            let r = c.runtime.lock().await;
            return Ok(
                json!({"thread":null,"settings":r.settings,"usage":r.usage,"generation":c.generation}),
            );
        }
    }
    Ok(json!({"thread":null,"settings":null,"usage":null,"generation":0}))
}
#[tauri::command]
pub async fn agent_account_status(
    s: State<'_, AppState>,
    harness: Option<Harness>,
) -> Result<Value, String> {
    if harness != Some(Harness::Claude) {
        return commands::codex_account_status(s).await;
    }
    let a = agent_get_account(s, Some(Harness::Claude)).await?;
    Ok(
        json!({"account":a["account"],"limits":null,"accountError":null,"limitsError":null,"generation":0}),
    )
}
#[tauri::command]
pub async fn agent_permission_options(
    s: State<'_, AppState>,
    harness: Option<Harness>,
) -> Result<Value, String> {
    if harness != Some(Harness::Claude) {
        return commands::codex_permission_options(s).await;
    }
    Ok(json!({"profiles":[],"approvalPolicies":[],"native":true}))
}
#[tauri::command]
pub async fn agent_set_permissions(
    s: State<'_, AppState>,
    thread_id: String,
    permissions: Option<String>,
    approval_policy: Option<String>,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_set_permissions(
            s,
            native(&thread_id),
            permissions,
            approval_policy,
        )
        .await;
    }
    Err("Claude permission rules are managed by Claude Code. Plan/Code is available in the composer.".into())
}
#[tauri::command]
pub async fn agent_revert_thread(
    s: State<'_, AppState>,
    thread_id: String,
    before_turn_id: String,
) -> Result<Value, String> {
    if harness(&thread_id) != Harness::Codex {
        return Err("Editing earlier messages is not supported for Claude conversations".into());
    }
    commands::codex_revert_thread(s, native(&thread_id), before_turn_id)
        .await
        .map(qualify)
}
#[tauri::command]
pub async fn agent_manage_thread(
    s: State<'_, AppState>,
    thread_id: String,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_manage_thread(s, native(&thread_id), action, name)
            .await
            .map(qualify);
    }
    let _op = s.operations.lock().await;
    claude_history(&s, &thread_id).await?;
    if action == "archive" {
        if let Ok(c) = existing(&s, &thread_id).await {
            c.shutdown(false).await?;
        }
    }
    let mut saved = s.settings.lock().await;
    match action.as_str() {
        "rename" => {
            let name = name.unwrap_or_default().trim().to_owned();
            if name.is_empty() || name.chars().count() > 200 {
                return Err("Use a title between 1 and 200 characters".into());
            }
            saved.claude_titles.insert(thread_id.clone(), name);
        }
        "archive" => {
            if !saved.claude_archived.contains(&thread_id) {
                saved.claude_archived.push(thread_id.clone())
            }
        }
        "restore" => saved.claude_archived.retain(|s| s != &thread_id),
        _ => return Err("Unknown conversation action".into()),
    }
    settings::save(&s.settings_path, &saved)?;
    Ok(json!({}))
}
#[tauri::command]
pub async fn agent_command_output(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    item_id: String,
    offset: usize,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Codex {
        return commands::codex_command_output(s, native(&thread_id), turn_id, item_id, offset)
            .await;
    }
    let (_, turns) = claude_history(&s, &thread_id).await?;
    let text = turns
        .iter()
        .find(|t| t["id"] == turn_id)
        .and_then(|t| t["items"].as_array())
        .into_iter()
        .flatten()
        .find(|i| i["id"] == item_id)
        .and_then(|i| i["output"].as_str())
        .unwrap_or("");
    let mut start = offset.min(text.len());
    while !text.is_char_boundary(start) {
        start -= 1
    }
    let end = (start + 20 * 1024).min(text.len());
    let text_part = crate::codex::normalize::prefix(&text[start..], end - start);
    Ok(json!({"text":text_part,"nextOffset":start+text_part.len(),"total":text.len()}))
}
#[tauri::command]
pub async fn agent_steer_turn(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    prompt: String,
    attachment_ids: Vec<String>,
    client_user_message_id: String,
) -> Result<Value, String> {
    if harness(&thread_id) == Harness::Claude {
        return Err("Claude follow-ups use Queue next in this version.".into());
    }
    commands::codex_steer_turn(
        s,
        native(&thread_id),
        turn_id,
        prompt,
        attachment_ids,
        client_user_message_id,
    )
    .await
}
#[tauri::command]
pub async fn agent_set_speed(
    s: State<'_, AppState>,
    generation: u64,
    mut targets: Vec<codex::speed::Target>,
    fast: bool,
) -> Result<Value, String> {
    if targets
        .iter()
        .any(|t| harness(&t.thread_id) == Harness::Claude)
    {
        return Err("Fast mode here applies to Codex conversations only".into());
    }
    for target in &mut targets {
        target.thread_id = native(&target.thread_id);
    }
    commands::codex_set_speed(s, generation, targets, fast)
        .await
        .map(qualify)
}
#[tauri::command]
pub async fn agent_sleep_now(
    s: State<'_, AppState>,
    harness: Option<Harness>,
) -> Result<(), String> {
    if harness == Some(Harness::Claude) {
        s.agents.claude.lock().await.shutdown(false).await
    } else {
        commands::codex_sleep_now(s).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_ids_are_namespaced_without_touching_turn_or_item_ids() {
        let v = qualify(
            json!({"thread":{"id":"same","cwd":"/project","preview":"title"},"turn":{"id":"turn"},"items":[{"id":"item","threadId":"same"}],"activeThreads":{"same":"turn"},"waitingThreads":["same"]}),
        );
        assert_eq!(v["thread"]["id"], "codex:same");
        assert_eq!(v["turn"]["id"], "turn");
        assert_eq!(v["items"][0]["id"], "item");
        assert_eq!(v["items"][0]["threadId"], "codex:same");
        assert_eq!(v["activeThreads"]["codex:same"], "turn");
        assert!(harness("claude:same") == Harness::Claude);
        assert!(harness("codex:same") == Harness::Codex);
        assert_eq!(qualify(v.clone()), v);
    }
    #[test]
    fn history_cursors_reject_invalid_offsets_and_page_older_items() {
        let items: Vec<_> = (0..250).map(|id| json!({"id":id})).collect();
        let page = page(items, Some("200".into()), 100).unwrap();
        assert_eq!(page["data"].as_array().unwrap().len(), 50);
        assert!(page["nextCursor"].is_null());
        assert!(super::page(vec![], Some("../wrong".into()), 30).is_err());
    }
}
