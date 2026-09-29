use bindaas::{files, git, settings};
use serde_json::Value;
use std::process::Command;

#[test]
fn fingerprint_survives_json_ipc_and_preserves_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let path = root.join("file.txt");
    std::fs::write(&path, "before\r\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let loaded = files::read(&root, "file.txt").unwrap();
    let value: Value = serde_json::to_value(&loaded.fingerprint).unwrap();
    assert!(value["modifiedNanos"].is_string());
    let fingerprint = serde_json::from_value(value).unwrap();
    files::save(&root, "file.txt", &fingerprint, "after\r\n").unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"after\r\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[tokio::test]
async fn git_scopes_nested_projects_and_separates_staged_changes() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let git_cmd = |args: &[&str]| {
        let status = Command::new("git")
            .args(args)
            .current_dir(root)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    };
    git_cmd(&["init"]);
    std::fs::create_dir(root.join("nested")).unwrap();
    std::fs::write(root.join("outside"), "before\n").unwrap();
    std::fs::write(root.join("nested/file with spaces.txt"), "before\n").unwrap();
    git_cmd(&["add", "."]);
    git_cmd(&[
        "-c",
        "user.name=Workbench fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-m",
        "fixture",
    ]);
    std::fs::write(root.join("outside"), "outside change\n").unwrap();
    std::fs::write(root.join("nested/file with spaces.txt"), "staged change\n").unwrap();
    git_cmd(&["add", "nested/file with spaces.txt"]);
    std::fs::write(
        root.join("nested/file with spaces.txt"),
        "unstaged change\n",
    )
    .unwrap();
    std::fs::write(root.join("nested/new\nfile"), "new\n").unwrap();
    let snapshot = git::snapshot(&root.join("nested")).await;
    assert!(snapshot.available);
    assert_eq!(snapshot.files.len(), 2);
    assert!(snapshot
        .files
        .iter()
        .all(|f| !f.path.starts_with("nested/") && f.path != "outside"));
    assert!(snapshot.staged.contains("+staged change"));
    assert!(snapshot.unstaged.contains("+unstaged change"));
    assert!(!snapshot.unstaged.contains("outside change"));
    // File search without Codex lists what git knows, relative to the project:
    // new files included, ignored ones and files outside the project left out.
    std::fs::write(root.join("nested/.gitignore"), "ignored.log\n").unwrap();
    std::fs::write(root.join("nested/ignored.log"), "noise\n").unwrap();
    let files = git::list_files(&root.join("nested")).await.unwrap();
    for expected in ["file with spaces.txt", "new\nfile", ".gitignore"] {
        assert!(files.iter().any(|f| f == expected), "missing {expected:?}");
    }
    assert!(!files
        .iter()
        .any(|f| f == "ignored.log" || f == "outside" || f.starts_with("..")));
}

#[test]
fn settings_recover_corruption_and_preserve_unknown_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    std::fs::write(&path, "broken").unwrap();
    let recovered = settings::load(&path);
    assert_eq!(recovered.schema_version, 2);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    std::fs::write(
        &path,
        r#"{"schemaVersion":2,"futureSetting":{"keep":true}}"#,
    )
    .unwrap();
    let loaded = settings::load(&path);
    settings::save(&path, &loaded).unwrap();
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["futureSetting"]["keep"], true);
    assert_eq!(saved["schemaVersion"], 2);
    // Settings written before motion modes existed keep the expressive default.
    assert_eq!(loaded.motion, "expressive");
    std::fs::write(&path, r#"{"schemaVersion":2,"motion":"saving"}"#).unwrap();
    assert_eq!(settings::load(&path).motion, "saving");
}

#[test]
fn permission_and_file_approvals_do_not_expand_grants() {
    use bindaas::codex::normalize::Approval;
    let permissions = serde_json::json!({"fileSystem":{"write":["/tmp/exact"]},"network":null});
    let a = Approval::new(
        serde_json::json!(1),
        "item/permissions/requestApproval",
        serde_json::json!({"permissions":permissions}),
    )
    .unwrap();
    assert_eq!(
        a.response(&serde_json::json!("decline"), None).unwrap(),
        serde_json::json!({"permissions":{},"scope":"turn"})
    );
    let allow = a.response(&serde_json::json!("accept"), None).unwrap();
    assert_eq!(
        allow["permissions"]["fileSystem"],
        permissions["fileSystem"]
    );
    assert!(allow["permissions"].get("network").is_none());
    let f = Approval::new(
        serde_json::json!(2),
        "item/fileChange/requestApproval",
        serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(
        f.response(&serde_json::json!("cancel"), None).unwrap(),
        serde_json::json!({"decision":"cancel"})
    );
}

#[test]
fn harness_migration_backs_up_settings_and_preserves_native_history_references() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settings.json");
    let original = r#"{"schemaVersion":1,"projectState":{"/project":"abc"},"pinnedThreads":["abc","claude:def"],"future":42}"#;
    std::fs::write(&path, original).unwrap();
    let s = settings::load(&path);
    assert_eq!(s.schema_version, 2);
    assert_eq!(s.project_state["/project"], "codex:abc");
    assert_eq!(s.pinned_threads, vec!["codex:abc", "claude:def"]);
    assert_eq!(s.extra["future"], 42);
    assert_eq!(
        std::fs::read_to_string(path.with_extension("pre-agents-v1.json")).unwrap(),
        original
    );
    assert_eq!(settings::load(&path).pinned_threads, s.pinned_threads);
}

#[test]
fn settings_and_attachments_move_over_from_the_previous_app_identifier() {
    let support = tempfile::tempdir().unwrap();
    let legacy = support.path().join("dev.tokenpanti.workbench");
    std::fs::create_dir_all(legacy.join("attachments")).unwrap();
    std::fs::write(
        legacy.join("settings.json"),
        r#"{"schemaVersion":2,"recentProjects":["/work/app"]}"#,
    )
    .unwrap();
    std::fs::write(legacy.join("attachments/a.txt"), "kept").unwrap();
    let config = support.path().join("dev.bindaas.desktop");
    assert!(settings::migrate_legacy(&config));
    assert_eq!(
        settings::load(&config.join("settings.json")).recent_projects,
        vec!["/work/app".to_string()]
    );
    assert_eq!(
        std::fs::read_to_string(config.join("attachments/a.txt")).unwrap(),
        "kept"
    );
    // Once migrated, nothing happens again.
    assert!(!settings::migrate_legacy(&config));
}
