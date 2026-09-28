use super::normalize::{self, Normalizer};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
const READ_CAP: u64 = 32 * 1024 * 1024;

pub fn config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude")
        })
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn directories(config: &Path, root: &Path) -> Vec<PathBuf> {
    let encoded: String = root
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let projects = config.join("projects");
    // Native long paths can include a hash suffix. Never inspect unrelated project bodies.
    let prefix: String = encoded.chars().take(200).collect();
    fs::read_dir(&projects)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            (name == encoded || (encoded.len() >= 200 && name.starts_with(&format!("{prefix}-"))))
                && e.file_type().is_ok_and(|m| m.is_dir() && !m.is_symlink())
        })
        .map(|e| e.path())
        .collect()
}
fn matches_root(v: &Value, root: &Path) -> bool {
    v["cwd"]
        .as_str()
        .is_some_and(|p| Path::new(p).canonicalize().ok().as_deref() == Some(root))
}
fn metadata(path: &Path, root: &Path) -> Option<Value> {
    let id = path.file_stem()?.to_str()?;
    if !valid_id(id) || fs::symlink_metadata(path).ok()?.file_type().is_symlink() {
        return None;
    }
    let mut f = fs::File::open(path).ok()?;
    let meta = f.metadata().ok()?;
    let mut head = vec![];
    Read::by_ref(&mut f)
        .take(128 * 1024)
        .read_to_end(&mut head)
        .ok()?;
    let mut tail = vec![];
    if meta.len() > 128 * 1024 {
        f.seek(SeekFrom::End(-(128 * 1024_i64))).ok()?;
        f.read_to_end(&mut tail).ok()?;
    }
    let mut rows: Vec<Value> = head
        .split(|b| *b == b'\n')
        .chain(tail.split(|b| *b == b'\n'))
        .filter_map(|s| serde_json::from_slice(s).ok())
        .collect();
    if !rows.iter().any(|v| matches_root(v, root)) || rows.iter().any(|v| v["isSidechain"] == true)
    {
        return None;
    }
    let preview = rows
        .iter()
        .find_map(|v| {
            if v["type"] == "user" {
                v["message"]["content"]
                    .as_str()
                    .or_else(|| {
                        v["message"]["content"]
                            .as_array()
                            .and_then(|a| a.iter().find_map(|b| b["text"].as_str()))
                    })
                    .filter(|s| !s.starts_with('<'))
                    .map(str::to_owned)
            } else {
                None
            }
        })
        .unwrap_or_else(|| "Claude conversation".into());
    let name = rows.iter().rev().find_map(|v| {
        v["customTitle"]
            .as_str()
            .or(v["summary"].as_str())
            .map(str::to_owned)
    });
    let model = rows
        .iter_mut()
        .rev()
        .find_map(|v| v["message"]["model"].as_str().map(str::to_owned));
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(
        json!({"id":format!("claude:{id}"),"harness":"claude","name":name,"preview":crate::codex::normalize::prefix(&preview,500),"cwd":root,"createdAt":modified,"updatedAt":modified,"status":{"type":"notLoaded"},"runStatus":"unknown","model":model}),
    )
}
pub fn list(config: &Path, root: &Path) -> Vec<Value> {
    let mut rows = vec![];
    for dir in directories(config, root) {
        for entry in fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .take(10000)
        {
            if entry.path().extension().is_some_and(|e| e == "jsonl") {
                if let Some(v) = metadata(&entry.path(), root) {
                    rows.push(v)
                }
            }
        }
    }
    rows.sort_by_key(|v| std::cmp::Reverse(v["updatedAt"].as_u64().unwrap_or(0)));
    rows
}
pub fn locate(config: &Path, root: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid Claude session ID".into());
    }
    directories(config, root)
        .into_iter()
        .map(|d| d.join(format!("{id}.jsonl")))
        .find(|p| metadata(p, root).is_some())
        .ok_or_else(|| "Claude conversation is missing or belongs to another project".into())
}
pub fn read(config: &Path, root: &Path, id: &str) -> Result<(Value, Vec<Value>), String> {
    let path = locate(config, root, id)?;
    let mut summary = metadata(&path, root).ok_or("Could not read Claude session")?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if length > READ_CAP {
        file.seek(SeekFrom::Start(length - READ_CAP))
            .map_err(|e| e.to_string())?;
        summary["historyTruncated"] = json!(true);
    }
    let mut rows = Vec::new();
    for line in BufReader::new(file.take(READ_CAP)).split(b'\n') {
        let line = line.map_err(|e| e.to_string())?;
        if let Ok(v) = serde_json::from_slice::<Value>(&line) {
            if v["isSidechain"] != true {
                rows.push(v)
            }
        }
    }
    // Follow native parent links rather than merging abandoned branches after a rewind.
    let index: HashMap<String, usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(i, v)| v["uuid"].as_str().map(|s| (s.into(), i)))
        .collect();
    let mut chain = HashSet::new();
    let mut cursor = rows
        .iter()
        .rev()
        .find(|v| v["type"] == "user" || v["type"] == "assistant")
        .and_then(|v| v["uuid"].as_str())
        .map(str::to_owned);
    while let Some(id) = cursor {
        if !chain.insert(id.clone()) {
            break;
        }
        cursor = index
            .get(&id)
            .and_then(|i| rows[*i]["parentUuid"].as_str())
            .map(str::to_owned);
    }
    let mut normalizer = Normalizer::default();
    let mut turns: Vec<Value> = vec![];
    let thread = format!("claude:{id}");
    for frame in rows {
        if let Some(uuid) = frame["uuid"].as_str() {
            if !chain.is_empty() && !chain.contains(uuid) {
                continue;
            }
        }
        let content = &frame["message"]["content"];
        let is_prompt = frame["type"] == "user"
            && (content.is_string()
                || content.as_array().is_some_and(|a| {
                    a.iter()
                        .any(|b| b["type"] == "text" || b["type"] == "image")
                        && !a.iter().any(|b| b["type"] == "tool_result")
                }));
        if is_prompt || (turns.is_empty() && frame["type"] == "assistant") {
            let tid = frame["uuid"].as_str().unwrap_or("recorded");
            turns.push(json!({"id":tid,"status":"unknown","items":[],"settings":normalize::settings(summary["model"].as_str(),None)}));
        }
        if let Some(turn) = turns.last_mut() {
            let tid = turn["id"].as_str().unwrap_or("").to_owned();
            for mut item in normalizer.message(&frame, &thread, &tid) {
                if item["status"] == "inProgress" {
                    item["status"] = json!("recorded");
                }
                let items = turn["items"].as_array_mut().unwrap();
                if let Some(pos) = items.iter().position(|i| i["id"] == item["id"]) {
                    items[pos] = item
                } else {
                    items.push(item)
                }
            }
        }
    }
    turns.reverse();
    Ok((summary, turns))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_scopes_native_history() {
        assert!(!valid_id("../secret"));
        let tmp = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let encoded: String = root
            .to_string_lossy()
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let dir = tmp.path().join("projects").join(encoded);
        fs::create_dir_all(&dir).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        fs::write(dir.join(format!("{id}.jsonl")),format!("{}\n{}\n",json!({"uuid":"u","type":"user","cwd":root,"message":{"content":"hello"}}),json!({"uuid":"a","parentUuid":"u","type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}))).unwrap();
        assert_eq!(list(tmp.path(), &root).len(), 1);
        let (_, turns) = read(tmp.path(), &root, id).unwrap();
        assert_eq!(turns[0]["items"].as_array().unwrap().len(), 2);
        assert!(locate(tmp.path(), Path::new("/different"), id).is_err());
    }
}
