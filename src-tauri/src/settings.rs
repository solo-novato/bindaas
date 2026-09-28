use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::Write, path::Path};
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub schema_version: u32,
    pub appearance: String,
    /// "expressive" (default) or "saving". Purely presentational; never affects agent behavior.
    pub motion: String,
    /// Access for conversations started in the app: "standard" (workspace, ask
    /// when needed) or "full" (full access, never ask). Existing conversations
    /// always keep their own permissions.
    pub new_chat_access: String,
    /// First-run setup was finished or skipped.
    pub onboarding_complete: bool,
    pub desktop_notifications: bool,
    pub pinned_threads: Vec<String>,
    pub codex_executable_path: Option<String>,
    pub codex_idle_timeout_seconds: u64,
    pub claude_enabled: bool,
    pub claude_executable_path: Option<String>,
    pub claude_titles: HashMap<String, String>,
    pub claude_archived: Vec<String>,
    pub recent_projects: Vec<String>,
    pub project_state: HashMap<String, String>,
    #[serde(skip_serializing)]
    pub last_model: Option<String>,
    #[serde(skip_serializing)]
    pub last_reasoning_effort: Option<String>,
    pub pane_sizes: HashMap<String, u32>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 2,
            appearance: "dark".into(),
            motion: "expressive".into(),
            new_chat_access: "standard".into(),
            onboarding_complete: false,
            desktop_notifications: false,
            pinned_threads: vec![],
            codex_executable_path: None,
            codex_idle_timeout_seconds: 300,
            claude_enabled: false,
            claude_executable_path: None,
            claude_titles: HashMap::new(),
            claude_archived: vec![],
            recent_projects: vec![],
            project_state: HashMap::new(),
            last_model: None,
            last_reasoning_effort: None,
            pane_sizes: HashMap::new(),
            extra: HashMap::new(),
        }
    }
}
/// Identifiers this app shipped under before it was renamed to Bindaas.
pub const LEGACY_IDENTIFIERS: &[&str] = &["dev.tokenpanti.workbench"];

/// Carries settings and saved attachments over from a previous app identifier, once.
/// The config folder is keyed by the bundle identifier, so a rename would otherwise
/// start from empty preferences. Returns true when something was migrated.
pub fn migrate_legacy(config_dir: &Path) -> bool {
    if config_dir.join("settings.json").exists() {
        return false;
    }
    let Some(parent) = config_dir.parent() else {
        return false;
    };
    for id in LEGACY_IDENTIFIERS {
        let legacy = parent.join(id);
        if !legacy.join("settings.json").is_file() {
            continue;
        }
        if !config_dir.exists() && fs::rename(&legacy, config_dir).is_ok() {
            return true;
        }
        if fs::create_dir_all(config_dir).is_err()
            || fs::copy(
                legacy.join("settings.json"),
                config_dir.join("settings.json"),
            )
            .is_err()
        {
            return false;
        }
        let attachments = legacy.join("attachments");
        if attachments.is_dir() && !config_dir.join("attachments").exists() {
            let _ = fs::rename(attachments, config_dir.join("attachments"));
        }
        return true;
    }
    false
}

pub fn load(path: &Path) -> Settings {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(mut s) => {
                let s: &mut Settings = &mut s;
                if s.schema_version < 2 {
                    let backup = path.with_extension("pre-agents-v1.json");
                    if !backup.exists() {
                        let _ = fs::copy(path, backup);
                    }
                    for id in s.project_state.values_mut() {
                        *id = crate::agents::codex_key(id);
                    }
                    for id in &mut s.pinned_threads {
                        *id = crate::agents::codex_key(id);
                    }
                    s.schema_version = 2;
                    let _ = save(path, s);
                }
                s.clone()
            }
            Err(_) => {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let _ = fs::copy(path, path.with_extension(format!("corrupt-{stamp}.json")));
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing settings folder")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
