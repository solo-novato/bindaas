pub mod agents;
pub mod attachments;
pub mod claude;
pub mod codex;
mod commands;
pub mod files;
pub mod git;
pub mod notifications;
pub mod settings;
pub mod shell_env;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

pub struct AppState {
    pub attachments: Arc<std::sync::Mutex<attachments::Store>>,
    pub project: Mutex<Option<PathBuf>>,
    pub settings: Mutex<settings::Settings>,
    pub settings_path: PathBuf,
    pub agents: agents::Registry,
    pub operations: Mutex<()>,
    pub quit_confirmed: AtomicBool,
    pub notifications: Arc<notifications::Notifications>,
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Resolve the user's shell environment in the background (see shell_env).
            shell_env::warm();
            let notices = Arc::new(notifications::Notifications::default());
            let event_notices = notices.clone();
            let handle = app.handle().clone();
            let sink: codex::Sink = Arc::new(move |name, payload| {
                if let Some((title, body)) =
                    event_notices.event(&name.replacen("agent://", "codex://", 1), &payload)
                {
                    use tauri_plugin_notification::NotificationExt;
                    let _ = handle
                        .notification()
                        .builder()
                        .title(title)
                        .body(body)
                        .show();
                }
                let _ = handle.emit(name, payload);
            });
            let config_dir = app.path().app_config_dir()?;
            settings::migrate_legacy(&config_dir);
            let path = config_dir.join("settings.json");
            let settings = settings::load(&path);
            notices
                .enabled
                .store(settings.desktop_notifications, Ordering::SeqCst);
            let claude_manager = claude::Manager::new(sink.clone());
            let mut manager = codex::Manager::new(agents::codex_sink(sink));
            manager.executable = settings.codex_executable_path.clone();
            manager.idle_timeout =
                std::time::Duration::from_secs(settings.codex_idle_timeout_seconds.max(5));
            let wake = manager.wake.clone();
            let manager = Arc::new(Mutex::new(manager));
            let m = manager.clone();
            tauri::async_runtime::spawn(async move {
                codex::start_idle_task(m, wake);
            });
            app.manage(AppState {
                attachments: Arc::new(std::sync::Mutex::new(attachments::Store::new(
                    path.parent().unwrap().join("attachments"),
                ))),
                project: Mutex::new(None),
                settings: Mutex::new(settings),
                settings_path: path,
                agents: agents::Registry {
                    codex: manager,
                    claude: Mutex::new(claude_manager),
                },
                operations: Mutex::new(()),
                quit_confirmed: AtomicBool::new(false),
                notifications: notices,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::attachments_pick,
            agents::agent_connect_claude,
            agents::agent_disconnect_claude,
            agents::agent_get_state,
            agents::agent_get_models,
            agents::agent_get_account,
            agents::agent_list_threads,
            agents::agent_resume_thread,
            agents::agent_thread_turns,
            agents::agent_turn_items,
            agents::agent_start_turn,
            agents::agent_interrupt_turn,
            agents::agent_respond_server_request,
            agents::agent_update_thread_settings,
            agents::agent_session_status,
            agents::agent_account_status,
            agents::agent_permission_options,
            agents::agent_set_permissions,
            agents::agent_manage_thread,
            agents::agent_revert_thread,
            agents::agent_command_output,
            agents::agent_steer_turn,
            agents::agent_set_speed,
            agents::agent_sleep_now,
            commands::attachment_preview,
            commands::attachment_paste_image,
            commands::settings_get,
            commands::settings_save,
            commands::project_pick_directory,
            commands::project_open,
            commands::project_close,
            commands::file_list_directory,
            commands::file_read,
            commands::file_stat,
            commands::file_save,
            commands::file_reveal_in_system,
            commands::file_open_default,
            commands::file_create,
            commands::file_rename,
            commands::file_trash,
            commands::codex_fuzzy_file_search,
            commands::git_refresh,
            commands::codex_get_state,
            commands::codex_get_models,
            commands::codex_get_account,
            commands::codex_start_chatgpt_login,
            commands::codex_cancel_login,
            commands::codex_choose_executable,
            commands::codex_detect,
            commands::app_open_notices,
            commands::codex_list_threads,
            commands::codex_manage_thread,
            commands::codex_steer_turn,
            commands::notification_test,
            commands::codex_resume_thread,
            commands::codex_update_thread_settings,
            commands::codex_permission_options,
            commands::codex_set_permissions,
            commands::codex_set_speed,
            commands::codex_session_status,
            commands::codex_account_status,
            commands::codex_thread_turns,
            commands::codex_turn_items,
            commands::codex_start_turn,
            commands::codex_interrupt_turn,
            commands::codex_respond_server_request,
            commands::codex_command_output,
            commands::codex_sleep_now,
            commands::app_quit,
            commands::open_external
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Bindaas")
        .run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                let state = handle.state::<AppState>();
                if !state.quit_confirmed.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = handle.emit("workbench://quit-requested", ());
                }
            }
            if let tauri::RunEvent::Exit = event {
                let state = handle.state::<AppState>();
                tauri::async_runtime::block_on(async {
                    let _ = state.agents.codex.lock().await.sleep(true).await;
                    let _ = state.agents.claude.lock().await.shutdown(true).await;
                });
            }
        });
}
