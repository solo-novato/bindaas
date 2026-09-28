use crate::{attachments, codex, files, git, settings, AppState};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};
use tauri::State;
async fn root(s: &AppState) -> Result<PathBuf, String> {
    s.project
        .lock()
        .await
        .clone()
        .ok_or("Open a project first".into())
}
async fn client(s: &AppState) -> Result<Arc<codex::Client>, String> {
    s.agents.codex.lock().await.ready().await
}
async fn idle(s: &AppState) -> Result<(), String> {
    if let Some(c) = &s.agents.codex.lock().await.client {
        if !c.idle().await {
            return Err("Stop the active task or finish login before switching projects".into());
        }
    }
    s.agents.claude.lock().await.shutdown(false).await?;
    Ok(())
}
async fn persist_thread(s: &AppState, root: &str, id: &str) -> Result<(), String> {
    let mut settings = s.settings.lock().await;
    settings
        .project_state
        .insert(root.into(), crate::agents::codex_key(id));
    settings::save(&s.settings_path, &settings)
}
fn thread_summary(t: &Value) -> Value {
    codex::runs::summary(t)
}
use crate::codex::conversations::verify_thread;

#[tauri::command]
pub async fn settings_get(s: State<'_, AppState>) -> Result<settings::Settings, String> {
    Ok(s.settings.lock().await.clone())
}
#[tauri::command]
pub async fn settings_save(
    s: State<'_, AppState>,
    value: settings::Settings,
) -> Result<(), String> {
    if !(5..=86400).contains(&value.codex_idle_timeout_seconds) {
        return Err("Idle timeout must be between 5 and 86400 seconds".into());
    }
    if !["dark", "light", "system"].contains(&value.appearance.as_str()) {
        return Err("Invalid appearance".into());
    }
    if let Some(path) = &value.codex_executable_path {
        codex::discover(Some(path))?;
    }
    let mut m = s.agents.codex.lock().await;
    if m.executable != value.codex_executable_path {
        m.sleep(false).await?;
    }
    m.executable = value.codex_executable_path.clone();
    m.idle_timeout = std::time::Duration::from_secs(value.codex_idle_timeout_seconds);
    m.wake.notify_one();
    for c in s.agents.claude.lock().await.clients.values() {
        c.set_idle_timeout(value.codex_idle_timeout_seconds);
    }
    let mut current = s.settings.lock().await;
    let mut value = value;
    value.recent_projects = current.recent_projects.clone();
    value.project_state = current.project_state.clone();
    value.claude_enabled = current.claude_enabled;
    value.claude_executable_path = current.claude_executable_path.clone();
    value.claude_titles = current.claude_titles.clone();
    value.claude_archived = current.claude_archived.clone();
    settings::save(&s.settings_path, &value)?;
    s.notifications
        .enabled
        .store(value.desktop_notifications, Ordering::SeqCst);
    *current = value;
    Ok(())
}
#[tauri::command]
pub async fn attachments_pick(
    s: State<'_, AppState>,
) -> Result<Vec<attachments::Attachment>, String> {
    root(&s).await?;
    let picked = rfd::AsyncFileDialog::new()
        .set_title("Attach files or images")
        .pick_files()
        .await;
    let Some(picked) = picked else {
        return Ok(vec![]);
    };
    if picked.len() > attachments::MAX_FILES {
        return Err("Choose at most 8 files".into());
    }
    let store = s.attachments.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        picked.iter().map(|f| store.import_file(f.path())).collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn attachment_preview(
    s: State<'_, AppState>,
    id: String,
) -> Result<attachments::Preview, String> {
    root(&s).await?;
    let store = s.attachments.clone();
    tokio::task::spawn_blocking(move || store.lock().map_err(|e| e.to_string())?.preview(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn attachment_paste_image(
    s: State<'_, AppState>,
    name: String,
    bytes: Vec<u8>,
) -> Result<attachments::Attachment, String> {
    root(&s).await?;
    let store = s.attachments.clone();
    tokio::task::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .import_bytes(&name, &bytes, true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn project_pick_directory() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Open a local project")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn project_open(s: State<'_, AppState>, path: String) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Choose a directory".into());
    }
    let same_project = s.project.lock().await.as_ref() == Some(&root);
    if !same_project {
        idle(&s).await?;
        s.agents.codex.lock().await.sleep(false).await?;
    }
    let snapshot = git::snapshot(&root).await;
    *s.project.lock().await = Some(root.clone());
    let text = root.to_string_lossy().into_owned();
    let mut settings = s.settings.lock().await;
    settings.recent_projects.retain(|p| p != &text);
    settings.recent_projects.insert(0, text.clone());
    settings.recent_projects.truncate(12);
    settings::save(&s.settings_path, &settings)?;
    Ok(
        json!({"root":text,"displayName":root.file_name().unwrap_or_default().to_string_lossy(),"git":snapshot,"lastThreadId":settings.project_state.get(&text)}),
    )
}
#[tauri::command]
pub async fn project_close(s: State<'_, AppState>) -> Result<(), String> {
    let _op = s.operations.lock().await;
    idle(&s).await?;
    s.agents.codex.lock().await.sleep(false).await?;
    *s.project.lock().await = None;
    Ok(())
}
#[tauri::command]
pub async fn file_list_directory(
    s: State<'_, AppState>,
    relative_path: String,
    show_hidden: bool,
) -> Result<files::Directory, String> {
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || files::list(&root, &relative_path, show_hidden))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_read(
    s: State<'_, AppState>,
    relative_path: String,
) -> Result<files::FileData, String> {
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || files::read(&root, &relative_path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_stat(
    s: State<'_, AppState>,
    relative_path: String,
) -> Result<files::Fingerprint, String> {
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || {
        files::fingerprint(&files::contained(&root, &relative_path)?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_save(
    s: State<'_, AppState>,
    relative_path: String,
    expected_fingerprint: files::Fingerprint,
    content: String,
) -> Result<files::FileData, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || {
        files::save(&root, &relative_path, &expected_fingerprint, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_reveal_in_system(
    s: State<'_, AppState>,
    relative_path: String,
) -> Result<(), String> {
    let p = files::contained(&root(&s).await?, &relative_path)?;
    // Finder selects the item itself rather than only opening its folder.
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
    }
    let parent = p.parent().ok_or("No parent directory")?;
    open::that(parent).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn file_open_default(
    s: State<'_, AppState>,
    relative_path: String,
) -> Result<(), String> {
    let p = files::safe_to_open(&root(&s).await?, &relative_path)?;
    open::that(p).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn file_create(
    s: State<'_, AppState>,
    parent: String,
    name: String,
    directory: bool,
) -> Result<String, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || files::create(&root, &parent, &name, directory))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_rename(
    s: State<'_, AppState>,
    relative_path: String,
    name: String,
) -> Result<String, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || files::rename(&root, &relative_path, &name))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn file_trash(s: State<'_, AppState>, relative_path: String) -> Result<(), String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    tokio::task::spawn_blocking(move || files::trash(&root, &relative_path))
        .await
        .map_err(|e| e.to_string())?
}
/// On-demand project file search through Codex. Runs only while the user is typing a query.
#[tauri::command]
pub async fn codex_fuzzy_file_search(
    s: State<'_, AppState>,
    query: String,
) -> Result<Value, String> {
    let root = root(&s).await?;
    let query = query.trim().to_owned();
    if query.is_empty() || query.chars().count() > 200 {
        return Ok(json!([]));
    }
    let c = client(&s).await?;
    let response = c
        .request(
            "fuzzyFileSearch",
            json!({
                "query": query,
                "roots": [root.to_string_lossy()],
                "cancellationToken": "workbench-file-search",
            }),
        )
        .await?;
    let mut files = Vec::new();
    for file in response["files"].as_array().into_iter().flatten() {
        let (Some(path), Some(base)) = (file["path"].as_str(), file["root"].as_str()) else {
            continue;
        };
        let absolute = PathBuf::from(base).join(path);
        // Only results inside the open project are offered.
        let Ok(relative) = absolute.strip_prefix(&root) else {
            continue;
        };
        if relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        let relative = relative.to_string_lossy().to_string();
        let same = relative == path;
        files.push(json!({
            "path": relative,
            "fileName": file["file_name"],
            "indices": if same { file["indices"].clone() } else { Value::Null },
        }));
        if files.len() == 50 {
            break;
        }
    }
    Ok(Value::Array(files))
}
#[tauri::command]
pub async fn codex_revert_thread(
    s: State<'_, AppState>,
    thread_id: String,
    before_turn_id: String,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let result = codex::conversations::revert(&c, &root, &thread_id, &before_turn_id).await?;
    c.resumed.lock().await.remove(&thread_id);
    Ok(result)
}
#[tauri::command]
pub async fn git_refresh(s: State<'_, AppState>) -> Result<git::GitSnapshot, String> {
    Ok(git::snapshot(&root(&s).await?).await)
}
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only safe HTTP(S) links are supported".into());
    }
    open::that(parsed.as_str()).map_err(|e| e.to_string())
}
/// First-run check: finds the Codex CLI and reads its version without starting the
/// app server or touching any project.
#[tauri::command]
pub async fn codex_detect(s: State<'_, AppState>) -> Result<Value, String> {
    let configured = s.settings.lock().await.codex_executable_path.clone();
    let path = tokio::task::spawn_blocking(move || codex::discover(configured.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    let mut command = tokio::process::Command::new(&path);
    crate::shell_env::apply(&mut command);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        command
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Codex did not answer `codex --version` in time")?
    .map_err(|e| format!("Could not run Codex: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let version = codex::codex_version(&text);
    Ok(json!({
        "path": path,
        "version": version.map(codex::version_text),
        "supported": version.is_none_or(|v| v >= codex::MIN_CODEX_VERSION),
        "minimum": codex::version_text(codex::MIN_CODEX_VERSION),
    }))
}
/// Opens the license notices bundled with the app.
#[tauri::command]
pub async fn app_open_notices(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let path = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("THIRD_PARTY_NOTICES.md");
    if !path.is_file() {
        return Err("Third-party notices are included in release builds.".into());
    }
    open::that(path).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn codex_choose_executable() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose installed Codex executable")
        .pick_file()
        .await
        .map(|f| f.path().to_string_lossy().into_owned())
}
#[tauri::command]
pub async fn codex_get_state(s: State<'_, AppState>) -> Result<Value, String> {
    let m = s.agents.codex.lock().await;
    Ok(if let Some(c) = &m.client {
        let active = c.active.lock().await.clone();
        let approvals = c.approvals.lock().await;
        json!({"type":if c.alive.load(Ordering::SeqCst){"ready"}else{"disconnected"},"generation":c.generation,"pid":c.pid,"activeThreads":active,"approvals":approvals.len(),"waitingThreads":approvals.values().filter_map(|a|a.params["threadId"].as_str().map(str::to_owned)).collect::<Vec<_>>()})
    } else {
        json!({"type":"sleeping"})
    })
}
#[tauri::command]
pub async fn codex_get_models(s: State<'_, AppState>) -> Result<Value, String> {
    let c = client(&s).await?;
    let mut models = vec![];
    let mut cursor = Value::Null;
    loop {
        let v = c
            .request(
                "model/list",
                json!({"limit":100,"cursor":cursor,"includeHidden":false}),
            )
            .await?;
        if let Some(data) = v["data"].as_array() {
            models.extend(data.iter().filter(|m|m["hidden"]!=true).map(|m|json!({"id":m["id"],"model":m["model"],"displayName":m["displayName"],"isDefault":m["isDefault"],"supportedReasoningEfforts":m["supportedReasoningEfforts"],"defaultReasoningEffort":m["defaultReasoningEffort"]})));
        }
        cursor = v["nextCursor"].clone();
        if cursor.is_null() || models.len() >= 500 {
            break;
        }
    }
    Ok(json!(models))
}
#[tauri::command]
pub async fn codex_get_account(s: State<'_, AppState>) -> Result<Value, String> {
    client(&s)
        .await?
        .request("account/read", json!({"refreshToken":false}))
        .await
}
#[tauri::command]
pub async fn codex_start_chatgpt_login(s: State<'_, AppState>) -> Result<Value, String> {
    let c = client(&s).await?;
    if c.login.swap(true, Ordering::SeqCst) {
        return Err("A login is already in progress".into());
    }
    match c
        .request("account/login/start", json!({"type":"chatgpt"}))
        .await
    {
        Ok(v) => Ok(v),
        Err(e) => {
            c.login.store(false, Ordering::SeqCst);
            Err(e)
        }
    }
}
#[tauri::command]
pub async fn codex_cancel_login(s: State<'_, AppState>, login_id: String) -> Result<Value, String> {
    let c = client(&s).await?;
    let v = c
        .request("account/login/cancel", json!({"loginId":login_id}))
        .await?;
    c.login.store(false, Ordering::SeqCst);
    c.touch().await;
    Ok(v)
}
#[tauri::command]
pub async fn codex_list_threads(
    s: State<'_, AppState>,
    cursor: Option<String>,
    archived: Option<bool>,
) -> Result<Value, String> {
    let root = root(&s).await?;
    let c = client(&s).await?;
    let v = c
        .request(
            "thread/list",
            json!({"cwd":root,"cursor":cursor,"limit":30,"sortKey":"updated_at","archived":archived.unwrap_or(false)}),
        )
        .await?;
    let data =
        codex::runs::summaries(c, v["data"].as_array().map(Vec::as_slice).unwrap_or(&[])).await;
    Ok(json!({"data":data,"nextCursor":v["nextCursor"]}))
}
#[tauri::command]
pub async fn codex_resume_thread(
    s: State<'_, AppState>,
    thread_id: String,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let current = verify_thread(&c, &thread_id, &root).await?;
    // Opening a conversation never changes its permissions.
    let v = c.resume_or_attach(&thread_id, &root, current).await?;
    let approvals: Vec<Value> = c
        .approvals
        .lock()
        .await
        .values()
        .filter(|a| a.params["threadId"] == thread_id)
        .map(|a| a.event(c.generation))
        .collect();
    persist_thread(&s, &root.to_string_lossy(), &thread_id).await?;
    let settings = c.effective_settings(&thread_id, &v).await;
    Ok(json!({"thread":thread_summary(&v["thread"]),"settings":settings,"approvals":approvals}))
}
#[tauri::command]
pub async fn codex_update_thread_settings(
    s: State<'_, AppState>,
    thread_id: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<codex::input::Mode>,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let current = verify_thread(&c, &thread_id, &root).await?;
    let resumed = c.resume_or_attach(&thread_id, &root, current).await?;
    let before = c.effective_settings(&thread_id, &resumed).await;
    let mut patch = json!({"threadId":thread_id});
    if let Some(model) = &model {
        patch["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        patch["effort"] = json!(effort);
    }
    if let Some(mode) = mode {
        let model = model
            .as_deref()
            .or_else(|| before["model"].as_str())
            .ok_or("Codex has not reported the thread model")?;
        patch["collaborationMode"] = json!({"mode":mode,"settings":{"model":model,"reasoning_effort":effort.as_deref().or_else(|| before["effort"].as_str()),"developer_instructions":null}});
    }
    if patch.as_object().is_some_and(|p| p.len() > 1) {
        c.update_settings(patch).await?;
    }
    Ok(c.effective_settings(&thread_id, &resumed).await)
}
#[tauri::command]
pub async fn codex_permission_options(s: State<'_, AppState>) -> Result<Value, String> {
    let root = root(&s).await?;
    let c = client(&s).await?;
    codex::session::permission_options(&c, &root).await
}
#[tauri::command]
pub async fn codex_set_permissions(
    s: State<'_, AppState>,
    thread_id: String,
    permissions: Option<String>,
    approval_policy: Option<String>,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let current = verify_thread(&c, &thread_id, &root).await?;
    let settings = codex::session::set_permissions(
        &c,
        &root,
        &thread_id,
        current,
        permissions.as_deref(),
        approval_policy.as_deref(),
    )
    .await?;
    Ok(settings)
}
#[tauri::command]
pub async fn codex_set_speed(
    s: State<'_, AppState>,
    generation: u64,
    targets: Vec<codex::speed::Target>,
    fast: bool,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    if c.generation != generation {
        return Err("Codex reconnected. Refresh status before changing speed.".into());
    }
    let results = codex::speed::apply(c.clone(), &root, targets, fast).await?;
    Ok(json!({"generation":c.generation,"results":results}))
}
#[tauri::command]
pub async fn codex_session_status(
    s: State<'_, AppState>,
    thread_id: Option<String>,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    if let Some(id) = thread_id {
        let current = verify_thread(&c, &id, &root).await?;
        let v = c.resume_or_attach(&id, &root, current).await?;
        let recorded = codex::thread_settings::recorded(v["thread"].clone()).await;
        let usage = c
            .usage
            .lock()
            .await
            .get(&id)
            .cloned()
            .unwrap_or(recorded.usage);
        let settings = c.effective_settings(&id, &v).await;
        Ok(
            json!({"thread":thread_summary(&v["thread"]),"settings":settings,"usage":usage,"generation":c.generation}),
        )
    } else {
        Ok(json!({"thread":null,"settings":null,"usage":null,"generation":c.generation}))
    }
}
#[tauri::command]
pub async fn codex_account_status(s: State<'_, AppState>) -> Result<Value, String> {
    let c = client(&s).await?;
    let (account, limits) = tokio::join!(
        c.request("account/read", json!({"refreshToken":false})),
        c.request("account/rateLimits/read", json!({}))
    );
    let (account, account_error) = match account {
        Ok(v) => (
            if v["account"].is_null() {
                Value::Null
            } else {
                json!({"type":v["account"]["type"],"email":v["account"]["email"],"planType":v["account"]["planType"]})
            },
            Value::Null,
        ),
        Err(e) => (Value::Null, json!(e)),
    };
    let (limits, limits_error) = match limits {
        Ok(v) => (codex::session::limits(&v), Value::Null),
        Err(e) => (Value::Null, json!(e)),
    };
    Ok(
        json!({"account":account,"limits":limits,"accountError":account_error,"limitsError":limits_error,"generation":c.generation}),
    )
}
#[tauri::command]
pub async fn codex_thread_turns(
    s: State<'_, AppState>,
    thread_id: String,
    cursor: Option<String>,
) -> Result<Value, String> {
    let root = root(&s).await?;
    let c = client(&s).await?;
    let verified = verify_thread(&c, &thread_id, &root).await?;
    let recorded = codex::thread_settings::recorded(verified["thread"].clone()).await;
    let v=c.request("thread/turns/list",json!({"threadId":thread_id,"limit":30,"cursor":cursor,"sortDirection":"desc","itemsView":"summary"})).await?;
    let thinking = c.thinking.lock().await.clone();
    let data = v["data"]
        .as_array()
        .map(|turns| {
            turns
                .iter()
                .map(|t| {
                    let mut turn = codex::normalize::turn(t);
                    turn["settings"] = recorded
                        .turns
                        .get(t["id"].as_str().unwrap_or(""))
                        .cloned()
                        .unwrap_or(Value::Null);
                    turn["items"] = json!(t["items"]
                        .as_array()
                        .map(|items| items
                            .iter()
                            .filter_map(|i| codex::normalize::history_item(
                                i,
                                &thread_id,
                                t["id"].as_str().unwrap_or(""),
                                t["status"] != "inProgress",
                                thinking.get(&thread_id)
                            ))
                            .collect::<Vec<_>>())
                        .unwrap_or_default());
                    turn
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(json!({"data":data,"nextCursor":v["nextCursor"]}))
}
#[tauri::command]
pub async fn codex_turn_items(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    cursor: Option<String>,
) -> Result<Value, String> {
    let root = root(&s).await?;
    let c = client(&s).await?;
    verify_thread(&c, &thread_id, &root).await?;
    let completed = c
        .active
        .lock()
        .await
        .get(&thread_id)
        .is_none_or(|turn| turn != &turn_id);
    let v=c.request("thread/items/list",json!({"threadId":thread_id,"turnId":turn_id,"limit":100,"cursor":cursor,"sortDirection":"asc"})).await?;
    let thinking = c.thinking.lock().await.clone();
    Ok(
        json!({"data":v["data"].as_array().map(|items|items.iter().filter_map(|i|codex::normalize::history_item(&i["item"],&thread_id,&turn_id,completed,thinking.get(&thread_id))).collect::<Vec<_>>()).unwrap_or_default(),"nextCursor":v["nextCursor"]}),
    )
}
// Tauri commands receive each IPC argument as a parameter.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn codex_start_turn(
    s: State<'_, AppState>,
    thread_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    mode: Option<codex::input::Mode>,
    attachment_ids: Option<Vec<String>>,
    permissions: Option<String>,
    approval_policy: Option<String>,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let attachment_ids = attachment_ids.unwrap_or_default();
    if (prompt.trim().is_empty() && attachment_ids.is_empty()) || prompt.len() > 128 * 1024 {
        return Err("Add a message or attachment; prompt limit is 128 KiB".into());
    }
    let store = s.attachments.clone();
    let input = tokio::task::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .input(&attachment_ids)
    })
    .await
    .map_err(|e| e.to_string())??;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let continuing = thread_id.is_some();
    let v = if let Some(id) = thread_id {
        let current = verify_thread(&c, &id, &root).await?;
        c.resume_or_attach(&id, &root, current).await?
    } else {
        let access = s.settings.lock().await.new_chat_access.clone();
        let (default_profile, default_policy) = codex::session::new_chat_permissions(&access);
        let permissions = Some(permissions.unwrap_or_else(|| default_profile.into()));
        let approval_policy = Some(approval_policy.unwrap_or_else(|| default_policy.into()));
        let mut params = json!({"cwd":root,"model":model});
        if permissions.is_some() || approval_policy.is_some() {
            let options = codex::session::permission_options(&c, &root).await?;
            codex::session::validate_permissions(
                &options,
                permissions.as_deref(),
                approval_policy.as_deref(),
            )?;
        }
        if let Some(profile) = permissions {
            params["permissions"] = json!(profile);
        }
        if let Some(policy) = approval_policy {
            params["approvalPolicy"] = json!(policy);
        }
        c.request("thread/start", params).await?
    };
    c.observe_resumed(&v).await?;
    let id = v["thread"]["id"]
        .as_str()
        .ok_or("Codex returned no thread ID")?
        .to_string();
    if c.active.lock().await.contains_key(&id) {
        return Err("This thread already has a running task; queue a follow-up or stop it".into());
    }
    c.resumed.lock().await.insert(id.clone(), v.clone());
    persist_thread(&s, &root.to_string_lossy(), &id).await?;
    let before = c.effective_settings(&id, &v).await;
    if continuing && mode.is_none() && before["mode"].is_null() {
        return Err(
            "Codex has not reported this thread's mode. Choose Plan or Code before sending.".into(),
        );
    }
    let resolved_model = model.as_deref().or_else(|| before["model"].as_str());
    if mode.is_some() && resolved_model.is_none() {
        return Err("Codex has not reported the thread model".into());
    }
    let resolved_effort = effort.as_deref().or_else(|| before["effort"].as_str());
    let baseline = git::snapshot(&root).await;
    c.emit("baseline", json!({"threadId":id,"git":baseline}));
    // Reserve active state before requesting to prevent sleeping or duplicate starts.
    c.active.lock().await.insert(id.clone(), String::new());
    let params = codex::input::turn_overrides(
        &id,
        &prompt,
        input,
        mode,
        if mode.is_some() {
            resolved_model
        } else {
            model.as_deref()
        },
        if mode.is_some() {
            resolved_effort
        } else {
            effort.as_deref()
        },
    );
    let response = c.request("turn/start", params).await;
    match response {
        Ok(r) => {
            let mut active = c.active.lock().await;
            if active.get(&id).is_some_and(|turn| turn.is_empty()) {
                active.insert(id.clone(), r["turn"]["id"].as_str().unwrap_or("").into());
            }
            drop(active);
            // A metadata read failure must not turn an accepted message into a retry.
            let current = c
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await
                .unwrap_or(Value::Null);
            let recorded = codex::thread_settings::recorded(current["thread"].clone()).await;
            let mut normalized = codex::normalize::turn(&r["turn"]);
            normalized["settings"] = recorded
                .turns
                .get(r["turn"]["id"].as_str().unwrap_or(""))
                .cloned()
                .unwrap_or(Value::Null);
            let mut settings = c.effective_settings(&id, &v).await;
            if settings["mode"].is_null() {
                if let Some(saved) = recorded.latest {
                    for key in ["model", "effort", "mode"] {
                        settings[key] = saved[key].clone();
                    }
                }
            }
            Ok(json!({"threadId":id,"turn":normalized,"settings":settings}))
        }
        Err(e) => {
            // A rejected/uncertain start must never kill unrelated running threads.
            if let Ok(current) = c
                .request("thread/read", json!({"threadId":id,"includeTurns":false}))
                .await
            {
                if current["thread"]["status"]["type"] == "active" {
                    let _ = c.observe_resumed(&current).await;
                } else if current["thread"]["status"]["type"] == "idle" {
                    let mut active = c.active.lock().await;
                    if active.get(&id).is_some_and(|turn| turn.is_empty()) {
                        active.remove(&id);
                    }
                }
            }
            Err(e)
        }
    }
}
#[tauri::command]
pub async fn codex_interrupt_turn(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let c = client(&s).await?;
    if c.active.lock().await.get(&thread_id) != Some(&turn_id) {
        return Err("This turn is no longer active".into());
    }
    c.request(
        "turn/interrupt",
        json!({"threadId":thread_id,"turnId":turn_id}),
    )
    .await
}
#[tauri::command]
pub async fn codex_respond_server_request(
    s: State<'_, AppState>,
    generation: u64,
    request_id: String,
    decision: Value,
    answers: Option<Value>,
) -> Result<(), String> {
    let m = s.agents.codex.lock().await;
    let c = m
        .client
        .as_ref()
        .ok_or("Approval connection no longer exists")?;
    c.respond(generation, &request_id, decision, answers).await
}
#[tauri::command]
pub async fn codex_command_output(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    item_id: String,
    offset: usize,
) -> Result<Value, String> {
    let m = s.agents.codex.lock().await;
    let c = m
        .client
        .as_ref()
        .ok_or("Output is unavailable after Codex sleeps; use Runs history")?;
    let output = c.output.lock().await;
    let text = output
        .get(&format!("{thread_id}:{turn_id}:{item_id}"))
        .ok_or("Output has been evicted; use Runs history")?;
    let mut start = offset.min(text.len());
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let chunk = codex::normalize::prefix(&text[start..], 20 * 1024);
    Ok(
        json!({"text":chunk,"nextOffset":start+chunk.len(),"total":text.len(),"retainedLimit":codex::normalize::OUTPUT_CAP}),
    )
}
#[tauri::command]
pub async fn codex_sleep_now(s: State<'_, AppState>) -> Result<(), String> {
    s.agents.codex.lock().await.sleep(false).await
}
#[tauri::command]
pub async fn app_quit(s: State<'_, AppState>) -> Result<(), String> {
    let c = s.agents.codex.lock().await.client.clone();
    if let Some(c) = c {
        let active = c.active.lock().await.clone();
        for (thread, turn) in active {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                c.request("turn/interrupt", json!({"threadId":thread,"turnId":turn})),
            )
            .await;
        }
    }
    s.agents.codex.lock().await.sleep(true).await?;
    s.agents.claude.lock().await.shutdown(true).await?;
    s.quit_confirmed.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn notification_test(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .request_permission()
        .map_err(|e| e.to_string())?;
    app.notification()
        .builder()
        .title("Bindaas")
        .body("Desktop notifications are ready. Tasks and requests for input will appear here.")
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_manage_thread(
    s: State<'_, AppState>,
    thread_id: String,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    let root = root(&s).await?;
    let c = client(&s).await?;
    let result =
        codex::conversations::manage(&c, &root, &thread_id, &action, name.as_deref()).await?;
    if action == "archive" || action == "restore" {
        c.resumed.lock().await.remove(&thread_id);
    }
    if action == "archive" {
        let mut settings = s.settings.lock().await;
        settings
            .project_state
            .retain(|_, id| id != &thread_id && id != &crate::agents::codex_key(&thread_id));
        settings::save(&s.settings_path, &settings)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn codex_steer_turn(
    s: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    prompt: String,
    attachment_ids: Vec<String>,
    client_user_message_id: String,
) -> Result<Value, String> {
    let _op = s.operations.lock().await;
    if (prompt.trim().is_empty() && attachment_ids.is_empty()) || prompt.len() > 128 * 1024 {
        return Err("Add a message or attachment; prompt limit is 128 KiB".into());
    }
    let root = root(&s).await?;
    let c = client(&s).await?;
    verify_thread(&c, &thread_id, &root).await?;
    let store = s.attachments.clone();
    let attachments = tokio::task::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .input(&attachment_ids)
    })
    .await
    .map_err(|e| e.to_string())??;
    if client_user_message_id.is_empty() || client_user_message_id.len() > 128 {
        return Err("Invalid message ID".into());
    }
    codex::conversations::steer(
        &c,
        &thread_id,
        &turn_id,
        &prompt,
        attachments,
        &client_user_message_id,
    )
    .await
}
