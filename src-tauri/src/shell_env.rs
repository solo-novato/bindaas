//! Apps opened from Finder inherit launchd's minimal environment
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the user's terminal setup. Codex installed
//! with npm, Homebrew, nvm, Volta, or bun — and the tools Codex runs for you — would
//! not be found. Like VS Code, we ask the user's login shell for its environment
//! once, in the background, and give it to the agent processes we start.

use std::{
    collections::HashMap,
    ffi::OsString,
    path::PathBuf,
    process::{Command, Stdio},
    sync::OnceLock,
    time::Duration,
};

const MARKER: &str = "__BINDAAS_ENV__";
const TIMEOUT: Duration = Duration::from_secs(5);

static SHELL_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// Starts resolving the shell environment without blocking the caller.
pub fn warm() {
    std::thread::spawn(|| {
        shell_env();
    });
}

fn shell_env() -> &'static HashMap<String, String> {
    SHELL_ENV.get_or_init(|| resolve().unwrap_or_default())
}

#[cfg(unix)]
fn resolve() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".into());
    // Interactive login shell, so both profile and rc files apply. Output is fenced
    // by markers because rc files may print banners.
    let script = format!("printf '{MARKER}'; /usr/bin/env -0; printf '{MARKER}'");
    let mut child = Command::new(&shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = match rx.recv_timeout(TIMEOUT) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();
    parse(&String::from_utf8_lossy(&bytes))
}

#[cfg(not(unix))]
fn resolve() -> Option<HashMap<String, String>> {
    None
}

fn parse(output: &str) -> Option<HashMap<String, String>> {
    let start = output.find(MARKER)? + MARKER.len();
    let end = start + output[start..].find(MARKER)?;
    Some(
        output[start..end]
            .split('\0')
            .filter_map(|entry| entry.split_once('='))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

/// Common install locations, used even when the shell could not be read.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for dir in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".bun/bin",
            ".cargo/bin",
            ".deno/bin",
            "Library/pnpm",
        ] {
            dirs.push(home.join(dir));
        }
        // nvm: prefer the newest installed Node.
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                dirs.push(latest.join("bin"));
            }
        }
    }
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from));
    dirs
}

/// The search path for agent processes: the login shell's PATH, then the app's own,
/// then well-known install locations — without duplicates.
pub fn search_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = shell_env().get("PATH") {
        dirs.extend(std::env::split_paths(path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.extend(well_known_dirs());
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Finds an executable by name on [`search_path`].
pub fn find(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&search_path())
        .map(|dir| dir.join(name))
        .find(|candidate| crate::codex::valid_executable(candidate))
}

/// Environment for agent processes: variables the user set up in their shell that the
/// app did not inherit (for example tool-manager or API-key variables), plus the
/// merged search path. Variables already present in the app's environment win.
pub fn apply(command: &mut tokio::process::Command) {
    for (key, value) in shell_env() {
        if std::env::var_os(key).is_none() && !ignored(key) {
            command.env(key, value);
        }
    }
    command.env("PATH", search_path());
}

/// Shell-session variables that must not leak into child processes.
fn ignored(key: &str) -> bool {
    matches!(
        key,
        "PWD" | "OLDPWD" | "SHLVL" | "_" | "PS1" | "PS2" | "PROMPT" | "RPROMPT" | "TERM_SESSION_ID"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_environment_between_markers_despite_banners() {
        let output = format!(
            "Welcome!\n{MARKER}PATH=/opt/homebrew/bin:/usr/bin\0EDITOR=vim\0MULTI=a=b\0{MARKER}bye"
        );
        let env = parse(&output).unwrap();
        assert_eq!(env["PATH"], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(env["EDITOR"], "vim");
        assert_eq!(env["MULTI"], "a=b");
        assert!(parse("no markers").is_none());
    }

    #[test]
    fn search_path_includes_common_install_locations_once() {
        let path = search_path();
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/usr/bin")));
        let unique: std::collections::HashSet<_> = dirs.iter().collect();
        assert_eq!(unique.len(), dirs.len());
    }
}
