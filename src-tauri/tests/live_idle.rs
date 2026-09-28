//! Opt-in installed-Codex lifecycle verification. No model turn or user project is used.
use bindaas::codex::{start_idle_task, Manager, Sink};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires CODEX_WORKBENCH_LIVE_EXECUTABLE and an installed, authenticated Codex CLI"]
async fn installed_codex_releases_idle_child_and_restarts() {
    let executable = std::env::var("CODEX_WORKBENCH_LIVE_EXECUTABLE")
        .expect("Set CODEX_WORKBENCH_LIVE_EXECUTABLE to the installed Codex executable or wrapper");
    let project = tempfile::tempdir().unwrap();
    let sink: Sink = Arc::new(|_, _| {});
    let mut manager = Manager::new(sink);
    manager.executable = Some(executable);
    manager.idle_timeout = Duration::from_secs(3);
    let wake = manager.wake.clone();
    let manager = Arc::new(Mutex::new(manager));
    start_idle_task(manager.clone(), wake);

    let result: Result<(), String> = async {
        let client = manager.lock().await.ready().await?;
        client
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        let thread = client
            .request(
                "thread/start",
                json!({"cwd":project.path(),"ephemeral":true,"sandbox":"read-only","approvalPolicy":"never"}),
            )
            .await?;
        if thread["thread"]["status"]["type"] != "idle" || !client.idle().await {
            return Err("The isolated thread did not become idle".into());
        }
        let generation = client.generation;
        let pid = client.pid;
        let started = tokio::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(20), async {
            while manager.lock().await.client.is_some() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .map_err(|_| "Idle manager did not release the real Codex child within 20 seconds")?;
        #[cfg(unix)]
        if unsafe { libc::kill(pid as i32, 0) } != -1
            || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        {
            return Err("Idle shutdown left the owned child alive".into());
        }
        let replacement = manager.lock().await.ready().await?;
        if replacement.generation <= generation {
            return Err("Restart did not establish a new connection generation".into());
        }
        replacement
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        println!(
            "Real Codex: idle child reaped, fresh connection responds; elapsed {:.2}s. No model turn was sent.",
            started.elapsed().as_secs_f64()
        );
        Ok(())
    }
    .await;

    // Always clean up only the processes owned by this isolated manager, including on failure.
    let cleanup = manager.lock().await.sleep(true).await;
    result.unwrap();
    cleanup.unwrap();
}
