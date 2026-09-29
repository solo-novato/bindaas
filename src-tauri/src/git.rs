use serde::Serialize;
use std::{path::Path, process::Stdio};
use tokio::{io::AsyncReadExt, process::Command};
pub const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

async fn run(root: &Path, args: &[&str]) -> Result<(Vec<u8>, bool), String> {
    let mut command = Command::new("git");
    crate::shell_env::apply(&mut command);
    let mut child = command
        .args(["--no-optional-locks", "-c", "core.quotepath=false"])
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut out = child.stdout.take().ok_or("Missing Git output")?;
    let mut data = Vec::new();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        (&mut out)
            .take((OUTPUT_LIMIT + 1) as u64)
            .read_to_end(&mut data)
            .await
            .map_err(|e| e.to_string())?;
        if data.len() > OUTPUT_LIMIT {
            child.kill().await.map_err(|e| e.to_string())?;
            data.truncate(OUTPUT_LIMIT);
            return Ok((data, true));
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Git unavailable or directory is not a repository".into());
        }
        Ok((data, false))
    })
    .await;
    result.map_err(|_| "Git operation timed out".to_string())?
}

/// Files git knows in the project: tracked, plus untracked files that are not
/// ignored. Read on demand for file search; nothing is cached or watched.
pub async fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let (bytes, _truncated) = run(
        root,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
    )
    .await?;
    let mut seen = std::collections::HashSet::new();
    Ok(bytes
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).into_owned())
        .filter(|p| seen.insert(p.clone()))
        .collect())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    pub status: String,
    pub original_path: Option<String>,
}
pub fn parse_status(bytes: &[u8]) -> Vec<GitFile> {
    let mut rows = bytes.split(|b| *b == 0);
    let mut files = Vec::new();
    while let Some(row) = rows.next() {
        let line = String::from_utf8_lossy(row);
        let (prefix, count) = match row.first() {
            Some(b'1') => ("", 9),
            Some(b'2') => ("", 10),
            Some(b'u') => ("U", 11),
            Some(b'?') => {
                files.push(GitFile {
                    path: line[2..].into(),
                    status: "??".into(),
                    original_path: None,
                });
                continue;
            }
            _ => continue,
        };
        let parts: Vec<_> = line.splitn(count, ' ').collect();
        if parts.len() != count {
            continue;
        }
        let original_path = if row[0] == b'2' {
            rows.next().map(|v| String::from_utf8_lossy(v).to_string())
        } else {
            None
        };
        files.push(GitFile {
            path: parts[count - 1].into(),
            status: if prefix.is_empty() {
                parts[1].into()
            } else {
                prefix.into()
            },
            original_path,
        });
    }
    files
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub available: bool,
    pub branch: String,
    pub head: String,
    pub files: Vec<GitFile>,
    pub unstaged: String,
    pub staged: String,
    pub truncated: bool,
    pub error: Option<String>,
}
pub async fn snapshot(root: &Path) -> GitSnapshot {
    let results = tokio::join!(
        run(root, &["status", "--porcelain=v2", "-z", "--", "."]),
        run(root, &["branch", "--show-current"]),
        run(root, &["rev-parse", "HEAD"]),
        run(
            root,
            &[
                "diff",
                "--relative",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                "."
            ]
        ),
        run(
            root,
            &[
                "diff",
                "--cached",
                "--relative",
                "--no-ext-diff",
                "--no-textconv",
                "--unified=3",
                "--",
                "."
            ]
        )
    );
    let (status, branch, head, unstaged, staged) = results;
    let prefix = run(root, &["rev-parse", "--show-prefix"])
        .await
        .ok()
        .map(|(v, _)| {
            String::from_utf8_lossy(&v)
                .trim_end_matches("\n")
                .to_string()
        })
        .unwrap_or_default();
    let diff_error = unstaged.as_ref().err().or(staged.as_ref().err()).cloned();
    match status {
        Err(e) => GitSnapshot {
            available: false,
            branch: String::new(),
            head: String::new(),
            files: vec![],
            unstaged: String::new(),
            staged: String::new(),
            truncated: false,
            error: Some(e),
        },
        Ok((data, mut truncated)) => {
            let mut decode = |result: Result<(Vec<u8>, bool), String>| {
                let (v, t) = result.unwrap_or_default();
                truncated |= t;
                String::from_utf8_lossy(&v).to_string()
            };
            let branch = decode(branch).trim().to_string();
            let head = decode(head).trim().to_string();
            let unstaged = decode(unstaged);
            let staged = decode(staged);
            GitSnapshot {
                available: true,
                branch,
                head,
                files: parse_status(&data)
                    .into_iter()
                    .filter_map(|mut f| {
                        let relative = f.path.strip_prefix(&prefix)?.to_string();
                        f.path = relative;
                        f.original_path = f
                            .original_path
                            .and_then(|p| p.strip_prefix(&prefix).map(str::to_owned));
                        Some(f)
                    })
                    .collect(),
                unstaged,
                staged,
                truncated,
                error: diff_error,
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_spaces_newlines_and_renames() {
        let data=b"1 .M N... 100644 100644 100644 a b file with\nnewline\0? new file\0  ignored\0 2ignored\0";
        let files = parse_status(data);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "file with\nnewline");
        let files = parse_status(b"2 R. N... 100644 100644 100644 a b R100 new name\0old name\0");
        assert_eq!(files[0].original_path.as_deref(), Some("old name"));
    }
}
