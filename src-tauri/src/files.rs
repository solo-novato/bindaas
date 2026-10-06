use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub const TEXT_LIMIT: u64 = 5 * 1024 * 1024;
pub const EDIT_WARNING: u64 = 1024 * 1024;
const DIRECTORY_LIMIT: usize = 2000;
const GENERATED: &[&str] = &[
    ".git",
    "node_modules",
    ".next",
    "dist",
    "build",
    "target",
    "vendor",
    ".venv",
    "venv",
    "coverage",
    ".turbo",
    ".cache",
];

pub fn contained(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Path must stay inside the active project".into());
    }
    let resolved = root.join(path).canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("Symlink points outside the project".into());
    }
    Ok(resolved)
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub size_bytes: u64,
    pub modified_nanos: String,
    pub hash: String,
}
pub fn fingerprint(path: &Path) -> Result<Fingerprint, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    // Huge files are metadata-only and can never be saved through this service.
    if metadata.len() <= TEXT_LIMIT {
        let mut file = fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(TEXT_LIMIT + 1);
        let mut buffer = [0; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
        }
    }
    Ok(Fingerprint {
        size_bytes: metadata.len(),
        modified_nanos: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default(),
        hash: format!("{:x}", hash.finalize()),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileData {
    pub path: String,
    pub content: Option<String>,
    pub encoding: String,
    pub size_bytes: u64,
    pub newline: String,
    pub fingerprint: Fingerprint,
    pub read_only_recommended: bool,
}
pub fn read(root: &Path, relative: &str) -> Result<FileData, String> {
    let path = contained(root, relative)?;
    if !path.is_file() {
        return Err("Not a regular file".into());
    }
    let before = fingerprint(&path)?;
    let (content, encoding) = if before.size_bytes > TEXT_LIMIT {
        (None, "unsupported")
    } else {
        let mut bytes = Vec::new();
        fs::File::open(&path)
            .map_err(|e| e.to_string())?
            .take(TEXT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > TEXT_LIMIT {
            return Err("File grew beyond the preview limit".into());
        }
        match String::from_utf8(bytes) {
            Ok(s) if !s.contains('\0') => (Some(s), "utf8"),
            _ => (None, "binary"),
        }
    };
    let after = fingerprint(&path)?;
    if before != after {
        return Err("File changed while reading; retry".into());
    }
    let newline = content
        .as_ref()
        .map(|s| {
            let crlf = s.matches("\r\n").count();
            let lf = s.matches('\n').count();
            if lf == 0 {
                "unknown"
            } else if crlf == lf {
                "crlf"
            } else if crlf == 0 {
                "lf"
            } else {
                "mixed"
            }
        })
        .unwrap_or("unknown");
    Ok(FileData {
        path: relative.into(),
        content,
        encoding: encoding.into(),
        size_bytes: before.size_bytes,
        newline: newline.into(),
        read_only_recommended: before.size_bytes > EDIT_WARNING,
        fingerprint: before,
    })
}

pub fn save(
    root: &Path,
    relative: &str,
    expected: &Fingerprint,
    content: &str,
) -> Result<FileData, String> {
    if content.len() as u64 > TEXT_LIMIT {
        return Err("File exceeds editing limit".into());
    }
    let path = contained(root, relative)?;
    if fingerprint(&path)? != *expected {
        return Err("CONFLICT: File changed on disk; compare or reload before saving".into());
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing parent")?)
        .map_err(|e| e.to_string())?;
    temp.as_file()
        .set_permissions(
            fs::metadata(&path)
                .map_err(|e| e.to_string())?
                .permissions(),
        )
        .map_err(|e| e.to_string())?;
    temp.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    // Recheck after preparing the atomic replacement, including symlink containment.
    if contained(root, relative)? != path || fingerprint(&path)? != *expected {
        return Err("CONFLICT: File changed during save".into());
    }
    temp.persist(&path).map_err(|e| e.to_string())?;
    read(root, relative)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub directory: bool,
    pub symlink: bool,
}
#[derive(Debug, Serialize)]
pub struct Directory {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}
pub fn list(root: &Path, relative: &str, show_hidden: bool) -> Result<Directory, String> {
    let path = contained(root, relative)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "Filename is not UTF-8")?;
        if !show_hidden && (name.starts_with('.') || GENERATED.contains(&name.as_str())) {
            continue;
        }
        if entries.len() == DIRECTORY_LIMIT {
            truncated = true;
            break;
        }
        let target = item.path();
        let entry_path = Path::new(relative)
            .join(&name)
            .to_string_lossy()
            .to_string();
        let file_type = item.file_type().map_err(|e| e.to_string())?;
        entries.push(Entry {
            name,
            path: entry_path,
            directory: target.is_dir(),
            symlink: file_type.is_symlink(),
        });
    }
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(Directory { entries, truncated })
}

/// Validates a user-typed name. Segments may be nested ("components/Button.svelte")
/// but can never climb out of the chosen folder.
fn name_parts(name: &str) -> Result<Vec<&str>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name".into());
    }
    if name.starts_with('/') || name.contains('\0') || name.contains('\\') {
        return Err("Use a name inside this folder".into());
    }
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "." || *p == "..") {
        return Err("Names cannot contain . or .. segments".into());
    }
    if parts.iter().any(|p| p.len() > 255) {
        return Err("Name is too long".into());
    }
    Ok(parts)
}

fn project_relative(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|_| "Path must stay inside the active project".into())
}

fn already_exists(name: &str) -> String {
    format!("‘{name}’ already exists here")
}

/// Locates an existing entry without following its final component, so renaming or
/// trashing a symlink acts on the link itself. The containing folder must be inside the project.
fn located(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative.trim_end_matches('/'));
    let name = relative
        .file_name()
        .ok_or("Choose a file or folder inside the project")?;
    let parent = contained(
        root,
        &relative
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    )?;
    let path = parent.join(name);
    fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if path == root {
        return Err("The project folder itself cannot be changed here".into());
    }
    Ok(path)
}

/// Creates an empty file or a folder. Never overwrites: an existing name is an error.
pub fn create(root: &Path, parent: &str, name: &str, directory: bool) -> Result<String, String> {
    let parts = name_parts(name)?;
    let mut current = contained(root, parent)?;
    if !current.is_dir() {
        return Err("Choose a folder to create in".into());
    }
    // Explorer identities retain the requested symlink spelling; only the I/O
    // path is canonicalized for containment checks.
    let relative_target = project_relative(root, &root.join(parent).join(parts.join("/")))?;
    let (last, folders) = parts.split_last().ok_or("Enter a name")?;
    for part in folders {
        let next = current.join(part);
        match fs::metadata(&next) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(format!("‘{part}’ already exists and is not a folder")),
            Err(_) => fs::create_dir(&next).map_err(|e| e.to_string())?,
        }
        current = next.canonicalize().map_err(|e| e.to_string())?;
        if !current.starts_with(root) {
            return Err("Symlink points outside the project".into());
        }
    }
    let target = current.join(last);
    let result = if directory {
        fs::create_dir(&target)
    } else {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map(|_| ())
    };
    result.map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => already_exists(last),
        _ => e.to_string(),
    })?;
    Ok(relative_target)
}

/// Renames within the same folder. Refuses to replace an existing entry.
pub fn rename(root: &Path, relative: &str, new_name: &str) -> Result<String, String> {
    let parts = name_parts(new_name)?;
    if parts.len() != 1 {
        return Err("Rename keeps the item in its folder; use a name without /".into());
    }
    let source = located(root, relative)?;
    let target = source.with_file_name(parts[0]);
    let relative_target = project_relative(
        root,
        &root
            .join(relative.trim_end_matches('/'))
            .with_file_name(parts[0]),
    )?;
    if target == source {
        return Ok(relative_target);
    }
    rename_exclusive(&source, &target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => already_exists(parts[0]),
        _ => e.to_string(),
    })?;
    Ok(relative_target)
}

#[cfg(target_os = "macos")]
fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt, os::unix::fs::MetadataExt};
    // Case-only renames on case-insensitive volumes target the same file.
    if let (Ok(a), Ok(b)) = (fs::symlink_metadata(from), fs::symlink_metadata(to)) {
        if a.ino() == b.ino() && a.dev() == b.dev() {
            return fs::rename(from, to);
        }
    }
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // SAFETY: both arguments are valid NUL-terminated paths for the duration of the call.
    if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(target_os = "macos"))]
fn rename_exclusive(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(std::io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

/// Moves an entry to the system Trash, where it can be restored.
pub fn trash(root: &Path, relative: &str) -> Result<(), String> {
    let path = located(root, relative)?;
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        // Avoids asking for permission to control Finder.
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(&path).map_err(|e| e.to_string())
}

/// Extensions macOS may run, install, or redirect when handed to the default app.
const RUNNABLE: &[&str] = &[
    "app",
    "command",
    "tool",
    "terminal",
    "sh",
    "bash",
    "zsh",
    "csh",
    "ksh",
    "fish",
    "py",
    "pyw",
    "rb",
    "pl",
    "php",
    "js",
    "mjs",
    "jar",
    "workflow",
    "action",
    "pkg",
    "mpkg",
    "dmg",
    "scpt",
    "scptd",
    "applescript",
    "fileloc",
    "webloc",
    "inetloc",
    "url",
    "prefpane",
    "kext",
    "bundle",
    "plugin",
    "osax",
    "service",
    "mobileconfig",
    "shortcut",
    "installer",
];

/// "Open in default app" never launches code from a project: folders (including app
/// bundles), executables, scripts, installers, and link files are refused.
pub fn safe_to_open(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = contained(root, relative)?;
    let blocked = "This file can run code or open something else, so Bindaas won't open it directly. Use Reveal in Finder instead.";
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err(blocked.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Err(blocked.into());
        }
    }
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if RUNNABLE.contains(&extension.as_str()) {
        return Err(blocked.into());
    }
    Ok(path)
}

/// Ranks project paths for a typed file search (used when Codex's search is not
/// installed): the query inside the file name first, then anywhere in the path,
/// then its characters in order (`apsv` → `src/App.svelte`). Indices are character
/// positions in the path, for highlighting.
pub fn rank_paths(paths: &[String], query: &str, limit: usize) -> Vec<serde_json::Value> {
    let needle: Vec<char> = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(lower)
        .collect();
    if needle.is_empty() {
        return vec![];
    }
    let mut hits: Vec<(i64, &String, Vec<usize>)> = paths
        .iter()
        .filter_map(|path| score(path, &needle).map(|(s, indices)| (s, path, indices)))
        .collect();
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(a.1.len().cmp(&b.1.len()))
            .then(a.1.cmp(b.1))
    });
    hits.into_iter()
        .take(limit)
        .map(|(_, path, indices)| {
            serde_json::json!({
                "path": path,
                "fileName": path.rsplit('/').next().unwrap_or(path),
                "indices": indices,
            })
        })
        .collect()
}

/// One lowercase character per character, so indices stay aligned with the path.
fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn score(path: &str, needle: &[char]) -> Option<(i64, Vec<usize>)> {
    let text: Vec<char> = path.chars().map(lower).collect();
    let name = path.rsplit('/').next().unwrap_or(path).chars().count();
    let name_start = text.len() - name;
    let n = needle.len();
    let length = text.len() as i64;
    let at = |i: usize| text[i..i + n] == *needle;
    if text.len() >= n {
        if let Some(i) = (name_start..=text.len() - n).find(|&i| at(i)) {
            let prefix = if i == name_start { 200 } else { 0 };
            return Some((3000 + prefix - length, (i..i + n).collect()));
        }
        if let Some(i) = (0..=text.len() - n).find(|&i| at(i)) {
            return Some((2000 - length, (i..i + n).collect()));
        }
    }
    let mut indices = Vec::with_capacity(n);
    for (i, c) in text.iter().enumerate() {
        if indices.len() < n && *c == needle[indices.len()] {
            indices.push(i);
        }
    }
    if indices.len() < n {
        return None;
    }
    let gaps: i64 = indices.windows(2).map(|w| (w[1] - w[0] - 1) as i64).sum();
    let in_name = indices.iter().filter(|&&i| i >= name_start).count() as i64;
    Some((1000 + (in_name * 10).min(900) - gaps - length / 4, indices))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_save_and_conflict() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        let p = root.join("a.txt");
        fs::write(&p, "hello\r\n").unwrap();
        let f = read(&root, "a.txt").unwrap();
        assert_eq!(f.newline, "crlf");
        fs::write(&p, "other\r\n").unwrap();
        assert!(save(&root, "a.txt", &f.fingerprint, "mine")
            .unwrap_err()
            .contains("CONFLICT"));
        assert_eq!(fs::read_to_string(&p).unwrap(), "other\r\n");
        let f = read(&root, "a.txt").unwrap();
        assert!(save(&root, "a.txt", &f.fingerprint, "mine\r\n").is_ok());
    }
    #[test]
    fn rejects_traversal_binary_and_giant() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        assert!(contained(&root, "../outside").is_err());
        assert!(contained(&root, "/etc/passwd").is_err());
        fs::write(root.join("binary"), [0, 255]).unwrap();
        assert_eq!(read(&root, "binary").unwrap().encoding, "binary");
        let f = fs::File::create(root.join("huge")).unwrap();
        f.set_len(TEXT_LIMIT + 1).unwrap();
        assert!(read(&root, "huge").unwrap().content.is_none());
    }
    #[cfg(unix)]
    #[test]
    fn create_never_overwrites_and_stays_inside() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("src")).unwrap();
        assert_eq!(create(&root, "src", "a.ts", false).unwrap(), "src/a.ts");
        std::fs::write(root.join("src/a.ts"), "keep").unwrap();
        assert!(create(&root, "src", "a.ts", false)
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.ts")).unwrap(),
            "keep"
        );
        assert_eq!(
            create(&root, "", "components/ui/Button.svelte", false).unwrap(),
            "components/ui/Button.svelte"
        );
        assert_eq!(create(&root, "src", "lib", true).unwrap(), "src/lib");
        assert!(create(&root, "src", "lib", true).is_err());
        for bad in ["", "../x", "a/../../x", "/etc/x", "a\0b", "."] {
            assert!(create(&root, "src", bad, false).is_err(), "{bad}");
        }
        assert!(create(&root, "../", "x", false).is_err());
        assert!(create(&root, "src/a.ts", "x", false).is_err());
    }

    #[test]
    fn create_refuses_symlinked_folders_outside_the_project() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        assert!(create(&root, "", "escape/x.txt", false).is_err());
        assert!(create(&root, "escape", "x.txt", false).is_err());
        assert!(!outside.path().join("x.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn create_preserves_in_project_symlink_paths() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        assert_eq!(
            create(&root, "alias", "a.txt", false).unwrap(),
            "alias/a.txt"
        );
        assert_eq!(
            create(&root, "", "alias/nested/b.txt", false).unwrap(),
            "alias/nested/b.txt"
        );
        assert_eq!(
            create(&root, "alias", "folder", true).unwrap(),
            "alias/folder"
        );
        assert!(root.join("real/a.txt").is_file());
        assert!(root.join("real/nested/b.txt").is_file());
        assert!(root.join("real/folder").is_dir());
        fs::write(root.join("real/a.txt"), "keep").unwrap();
        assert!(create(&root, "alias", "a.txt", false).is_err());
        assert_eq!(fs::read_to_string(root.join("real/a.txt")).unwrap(), "keep");
    }

    #[test]
    fn rename_refuses_existing_targets_and_keeps_contents() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        std::fs::write(root.join("b.txt"), "b").unwrap();
        assert!(rename(&root, "a.txt", "b.txt")
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "b");
        assert_eq!(rename(&root, "a.txt", "c.txt").unwrap(), "c.txt");
        assert_eq!(std::fs::read_to_string(root.join("c.txt")).unwrap(), "a");
        assert!(rename(&root, "c.txt", "../c.txt").is_err());
        assert!(rename(&root, "c.txt", "sub/c.txt").is_err());
        assert!(rename(&root, "", "x").is_err());
        assert!(rename(&root, "missing.txt", "x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rename_preserves_in_project_symlink_paths_and_file_contents() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/a.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        assert_eq!(
            rename(&root, "alias/a.txt", "a.txt").unwrap(),
            "alias/a.txt"
        );
        assert_eq!(fs::read_to_string(root.join("real/a.txt")).unwrap(), "keep");
        assert_eq!(
            rename(&root, "alias/a.txt", "b.txt").unwrap(),
            "alias/b.txt"
        );
        assert!(!root.join("real/a.txt").exists());
        assert_eq!(fs::read_to_string(root.join("real/b.txt")).unwrap(), "keep");
        let listed = list(&root, "alias", false).unwrap();
        assert_eq!(listed.entries[0].path, "alias/b.txt");
        assert_eq!(read(&root, "alias/b.txt").unwrap().path, "alias/b.txt");
        fs::write(root.join("real/c.txt"), "existing").unwrap();
        assert!(rename(&root, "alias/b.txt", "c.txt").is_err());
        assert_eq!(
            fs::read_to_string(root.join("real/c.txt")).unwrap(),
            "existing"
        );
        assert_eq!(fs::read_to_string(root.join("real/b.txt")).unwrap(), "keep");
    }

    #[cfg(unix)]
    #[test]
    fn rename_refuses_symlinked_folders_outside_the_project() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        fs::write(outside.path().join("a.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        for name in ["a.txt", "b.txt"] {
            assert!(rename(&root, "escape/a.txt", name).is_err());
        }
        assert_eq!(
            fs::read_to_string(outside.path().join("a.txt")).unwrap(),
            "keep"
        );
        assert!(!outside.path().join("b.txt").exists());
    }

    #[test]
    fn trash_refuses_the_project_and_outside_paths() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        assert!(trash(&root, "").is_err());
        assert!(trash(&root, "../").is_err());
        assert!(trash(&root, "/etc/hosts").is_err());
        assert!(trash(&root, "missing").is_err());
    }

    #[test]
    fn open_in_default_app_refuses_anything_that_can_run() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        for name in ["notes.md", "logo.png", "data.json"] {
            std::fs::write(root.join(name), "x").unwrap();
            assert!(safe_to_open(&root, name).is_ok(), "{name}");
        }
        for name in ["run.command", "Setup.PKG", "tool.sh", "go.webloc", "x.py"] {
            std::fs::write(root.join(name), "x").unwrap();
            assert!(safe_to_open(&root, name).is_err(), "{name}");
        }
        std::fs::create_dir(root.join("Evil.app")).unwrap();
        assert!(safe_to_open(&root, "Evil.app").is_err());
        std::fs::write(root.join("script"), "#!/bin/sh").unwrap();
        std::fs::set_permissions(root.join("script"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        assert!(safe_to_open(&root, "script").is_err());
        std::os::unix::fs::symlink(root.join("run.command"), root.join("readme.txt")).unwrap();
        assert!(safe_to_open(&root, "readme.txt").is_err());
    }

    #[test]
    fn rejects_external_symlink() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("escape")).unwrap();
        assert!(contained(&d.path().canonicalize().unwrap(), "escape").is_err());
    }
    #[test]
    fn file_search_prefers_names_then_paths_then_characters_in_order() {
        let paths: Vec<String> = [
            "src/lib/components/MentionMenu.svelte",
            "docs/mentions.md",
            "src/App.svelte",
            "src/app.css",
            "README.md",
        ]
        .iter()
        .map(|p| p.to_string())
        .collect();
        let names = |q: &str| -> Vec<String> {
            rank_paths(&paths, q, 10)
                .iter()
                .map(|v| v["path"].as_str().unwrap().to_string())
                .collect()
        };
        // File names that start with the query come first; case is ignored.
        assert_eq!(
            names("Mention")[..2],
            ["docs/mentions.md", "src/lib/components/MentionMenu.svelte"]
        );
        assert_eq!(names("app")[..2], ["src/app.css", "src/App.svelte"]);
        // Characters in order still match, highlighted where they matched.
        let hit = &rank_paths(&paths, "apsv", 10)[0];
        assert_eq!(hit["path"], "src/App.svelte");
        assert_eq!(hit["fileName"], "App.svelte");
        assert_eq!(hit["indices"], serde_json::json!([4, 5, 8, 9]));
        let lib = &rank_paths(&paths, "lib/comp", 10)[0];
        assert_eq!(
            lib["indices"],
            serde_json::json!([4, 5, 6, 7, 8, 9, 10, 11])
        );
        assert!(names("zzz").is_empty());
        assert!(names("  ").is_empty());
    }
}
