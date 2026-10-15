//! Bounded, on-demand import of quota counters only. Never copy conversation text.
use super::{ImportStatus, Sample};
use serde_json::Value;
use std::{
    fs,
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
};

const LINE_CAP: usize = 256 * 1024;
const BYTE_CAP: u64 = 2 * 1024 * 1024 * 1024;
pub(super) const REVISION: u32 = 3;
const FILE_CAP: usize = 10_000;

// Discard oversized records without allocating memory proportional to their size.
fn line(reader: &mut impl BufRead, budget: &mut u64) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        if *budget == 0 {
            return Ok(None);
        }
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(None);
        } // Ignore unfinished last records.
        let count = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1)
            .min(*budget as usize);
        let done = available[count - 1] == b'\n';
        if !oversized && bytes.len() + count <= LINE_CAP {
            bytes.extend_from_slice(&available[..count]);
        } else {
            oversized = true;
            bytes.clear();
        }
        reader.consume(count);
        *budget -= count as u64;
        if done {
            return Ok(Some(bytes));
        }
    }
}

fn files(root: &Path, depth: usize, found: &mut Vec<PathBuf>, limited: &mut bool) {
    if found.len() >= FILE_CAP {
        *limited = true;
        return;
    }
    // Codex uses sessions/YYYY/MM/DD and a flat archived_sessions folder.
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            *limited = true;
            return;
        }
    };
    for entry in entries {
        if found.len() >= FILE_CAP {
            *limited = true;
            break;
        }
        let Ok(entry) = entry else {
            *limited = true;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *limited = true;
            continue;
        };
        if kind.is_symlink() {
            *limited = true;
            continue;
        }
        let path = entry.path();
        if kind.is_file() && path.extension().is_some_and(|s| s == "jsonl") {
            found.push(path);
        } else if kind.is_dir()
            && depth > 0
            && entry
                .file_name()
                .to_string_lossy()
                .bytes()
                .all(|b| b.is_ascii_digit())
        {
            files(&path, depth - 1, found, limited);
        }
    }
}

pub(super) fn read(
    root: &Path,
    identity: &str,
    plan: &Value,
    limits: &Value,
    now: u64,
) -> (Vec<Sample>, ImportStatus) {
    let mut status = ImportStatus {
        at: now,
        revision: REVISION,
        ..Default::default()
    };
    let mut paths = vec![];
    for name in ["sessions", "archived_sessions"] {
        let directory = root.join(name);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            _ => {
                status.limited = true;
                continue;
            }
        }
        files(&directory, 3, &mut paths, &mut status.limited);
    }
    // Prefer recent evidence if the bounded read cannot cover the whole profile.
    paths.sort_by(|a, b| b.cmp(a));
    let mut budget = BYTE_CAP;
    let mut candidates = vec![];
    let mut matched = false;
    let mut conflicting = false;
    // Inspect every available header before attributing old, untagged sessions.
    // A profile with multiple known accounts must never merge its legacy history.
    for path in paths {
        let Ok(file) = crate::files::open_regular(&path) else {
            status.limited = true;
            continue;
        };
        let mut reader = BufReader::new(file);
        let before = budget.min(LINE_CAP as u64);
        let mut head_budget = before;
        let header = line(&mut reader, &mut head_budget);
        budget -= before - head_budget;
        let Ok(Some(header)) = header else {
            status.limited = true;
            continue;
        };
        let Ok(meta) = serde_json::from_slice::<Value>(&header) else {
            status.limited = true;
            continue;
        };
        if meta["type"] != "session_meta" {
            status.limited = true;
            continue;
        }
        match meta["payload"]["creator_account_id"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            Some(id) if id == identity => {
                matched = true;
                candidates.push((path, false));
            }
            Some(_) => conflicting = true,
            None => candidates.push((path, true)),
        }
    }
    let legacy_allowed = matched && !conflicting && !status.limited;
    let mut samples = vec![];
    for (path, legacy) in candidates {
        if legacy && !legacy_allowed {
            status.unattributed_files += 1;
            continue;
        }
        if budget == 0 {
            status.limited = true;
            break;
        }
        let Ok(file) = crate::files::open_regular(&path) else {
            status.limited = true;
            continue;
        };
        let mut reader = BufReader::new(file);
        // Consume the header again; source records are never modified.
        if !matches!(line(&mut reader, &mut budget), Ok(Some(_))) {
            status.limited = true;
            continue;
        }
        if legacy {
            status.legacy_files += 1;
        }
        status.files += 1;
        loop {
            let bytes = match line(&mut reader, &mut budget) {
                Ok(Some(bytes)) => bytes,
                Ok(None) => break,
                Err(_) => {
                    status.limited = true;
                    break;
                }
            };
            // This prefilter keeps prompts, responses and tool output out of JSON parsing.
            if !bytes.windows(13).any(|s| s == b"\"token_count\"") {
                continue;
            }
            let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let p = &record["payload"];
            if record["type"] != "event_msg" || p["type"] != "token_count" {
                continue;
            }
            let rate = &p["rate_limits"];
            if &rate["plan_type"] != plan {
                continue;
            }
            let Some(at) = record["timestamp"]
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .and_then(|d| u64::try_from(d.timestamp()).ok())
            else {
                continue;
            };
            if at > now {
                continue;
            }
            let Some(buckets) = limits["buckets"].as_array() else {
                continue;
            };
            for bucket in buckets {
                let Some(id) = bucket["id"].as_str() else {
                    continue;
                };
                if rate["limit_id"].as_str() != Some(id) {
                    continue;
                }
                for slot in ["primary", "secondary"] {
                    let Some(minutes) = bucket[slot]["windowDurationMins"].as_u64() else {
                        continue;
                    };
                    // A weekly window can move from secondary to primary across CLI versions.
                    let windows: Vec<&Value> = ["primary", "secondary"]
                        .iter()
                        .map(|k| &rate[*k])
                        .filter(|w| w["window_minutes"].as_u64() == Some(minutes))
                        .collect();
                    if windows.len() != 1 || minutes == 0 {
                        continue;
                    }
                    let w = windows[0];
                    let (Some(used), Some(reset)) =
                        (w["used_percent"].as_f64(), w["resets_at"].as_u64())
                    else {
                        continue;
                    };
                    if !used.is_finite()
                        || !(0.0..=100.0).contains(&used)
                        || reset < at
                        || reset.saturating_sub(at) > minutes.saturating_mul(60)
                    {
                        continue;
                    }
                    samples.push(Sample {
                        at,
                        bucket: format!("{id}:{slot}"),
                        minutes,
                        reset,
                        used,
                        inferred: legacy,
                    });
                    status.observations += 1;
                }
            }
        }
    }
    if budget == 0 {
        status.limited = true;
    }
    (samples, status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture(root: &Path, name: &str, identity: &str, plan: &str, slot: &str) {
        let directory = root.join("sessions/2026/10/01");
        fs::create_dir_all(&directory).unwrap();
        let meta = json!({"type":"session_meta","payload":{"creator_account_id":identity}});
        let mut rate = json!({"limit_id":"codex","plan_type":plan});
        rate[slot] = json!({"used_percent":20,"window_minutes":10080,"resets_at":1790900000});
        let event = json!({"timestamp":"2026-10-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":rate}});
        fs::write(directory.join(name), format!("{meta}\n{event}\n")).unwrap();
    }
    #[test]
    fn imports_only_matching_account_plan_and_duration_and_remaps_slots() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), "ours.jsonl", "account-a", "pro", "secondary");
        fixture(dir.path(), "other.jsonl", "account-b", "pro", "primary");
        fixture(dir.path(), "plan.jsonl", "account-a", "plus", "primary");
        let limits = json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080},"secondary":{"windowDurationMins":300}}]});
        let (samples, status) = read(dir.path(), "account-a", &json!("pro"), &limits, 1791000000);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].bucket, "codex:primary");
        assert_eq!(status.observations, 1);
        assert!(!status.limited);
    }
    #[test]
    fn persisted_import_is_deduplicated_and_rechecked_on_a_new_day() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), "ours.jsonl", "account-a", "pro", "secondary");
        let store = dir.path().join("usage.json");
        let account = json!({"type":"chatgpt","planType":"pro","usageIdentity":"account-a"});
        let limits = json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]});
        let (first, imported) = super::super::record_with_history(
            &store,
            &account,
            &limits,
            1791000000,
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(imported.unwrap().observations, 1);
        fixture(dir.path(), "duplicate.jsonl", "account-a", "pro", "primary");
        let (second, imported) = super::super::record_with_history(
            &store,
            &account,
            &limits,
            1791000001,
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(second, first);
        assert_eq!(imported.unwrap().files, 1);
        let (third, imported) = super::super::record_with_history(
            &store,
            &account,
            &limits,
            1791086400,
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(third, first);
        assert_eq!(imported.unwrap().files, 2);
        assert!(!fs::read_to_string(store).unwrap().contains("account-a"));
    }

    #[test]
    fn merges_all_projects_without_adding_duplicate_account_counters() {
        let dir = tempfile::tempdir().unwrap();
        for (name, project) in [
            ("one.jsonl", "/projects/one"),
            ("two.jsonl", "/projects/two"),
        ] {
            fixture(dir.path(), name, "account-a", "pro", "primary");
            let path = dir.path().join("sessions/2026/10/01").join(name);
            let content = fs::read_to_string(&path).unwrap();
            let mut lines = content.lines();
            let mut meta: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
            meta["payload"]["cwd"] = json!(project);
            fs::write(path, format!("{meta}\n{}\n", lines.next().unwrap())).unwrap();
        }
        let account = json!({"type":"chatgpt","planType":"pro","usageIdentity":"account-a"});
        let limits = json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]});
        let (samples, status) = super::super::record_with_history(
            &dir.path().join("usage.json"),
            &account,
            &limits,
            1791000000,
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(status.unwrap().files, 2);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].used, 20.0);
    }

    #[test]
    fn legacy_profile_attribution_is_retracted_if_another_account_is_found() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), "known.jsonl", "account-a", "pro", "primary");
        fixture(dir.path(), "legacy.jsonl", "", "pro", "primary");
        let legacy = dir.path().join("sessions/2026/10/01/legacy.jsonl");
        let content = fs::read_to_string(&legacy)
            .unwrap()
            .replace("2026-10-01T00:00:00Z", "2026-10-01T00:10:00Z");
        fs::write(legacy, content).unwrap();
        let store = dir.path().join("usage.json");
        let account = json!({"type":"chatgpt","planType":"pro","usageIdentity":"account-a"});
        let limits = json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]});
        let (samples, status) = super::super::record_with_history(
            &store,
            &account,
            &limits,
            1791000000,
            Some(dir.path()),
        )
        .unwrap();
        assert_eq!(status.unwrap().legacy_files, 1);
        assert_eq!(samples.iter().filter(|s| s.inferred).count(), 1);
        fixture(dir.path(), "other.jsonl", "account-b", "pro", "primary");
        let (samples, status) = super::super::record_with_history(
            &store,
            &account,
            &limits,
            1791086400,
            Some(dir.path()),
        )
        .unwrap();
        let status = status.unwrap();
        assert_eq!(status.legacy_files, 0);
        assert_eq!(status.unattributed_files, 1);
        assert_eq!(samples.len(), 1);
        assert!(!samples[0].inferred);
    }

    #[test]
    fn legacy_requires_matching_account_evidence_and_complete_headers() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), "legacy.jsonl", "", "pro", "primary");
        let limits = json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]});
        let (samples, status) = read(dir.path(), "account-a", &json!("pro"), &limits, 1791000000);
        assert!(samples.is_empty());
        assert_eq!(status.unattributed_files, 1);
        fixture(dir.path(), "known.jsonl", "account-a", "pro", "primary");
        fs::write(
            dir.path().join("sessions/2026/10/01/broken.jsonl"),
            "invalid\n",
        )
        .unwrap();
        let (samples, status) = read(dir.path(), "account-a", &json!("pro"), &limits, 1791000000);
        assert_eq!(samples.len(), 1);
        assert!(status.limited);
        assert_eq!(status.unattributed_files, 1);
    }

    #[test]
    fn unavailable_history_directory_prevents_legacy_account_attribution() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path(), "known.jsonl", "account-a", "pro", "primary");
        fixture(dir.path(), "legacy.jsonl", "", "pro", "primary");
        // A non-directory at a history root cannot be treated as a complete scan.
        fs::write(dir.path().join("archived_sessions"), "unavailable").unwrap();
        let (samples, status) = read(
            dir.path(),
            "account-a",
            &json!("pro"),
            &json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]}),
            1791000000,
        );
        assert!(status.limited);
        assert_eq!(status.unattributed_files, 1);
        assert_eq!(status.legacy_files, 0);
        assert_eq!(samples.len(), 1);
        assert!(!samples[0].inferred);
    }

    #[cfg(unix)]
    #[test]
    fn skipped_account_history_prevents_legacy_account_attribution() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(dir.path(), "known.jsonl", "account-a", "pro", "primary");
        fixture(dir.path(), "legacy.jsonl", "", "pro", "primary");
        fixture(outside.path(), "other.jsonl", "account-b", "pro", "primary");
        std::os::unix::fs::symlink(
            outside.path().join("sessions/2026/10/01/other.jsonl"),
            dir.path().join("sessions/2026/10/01/other.jsonl"),
        )
        .unwrap();
        let (samples, status) = read(
            dir.path(),
            "account-a",
            &json!("pro"),
            &json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]}),
            1791000000,
        );
        assert!(status.limited);
        assert_eq!(status.unattributed_files, 1);
        assert!(samples.iter().all(|sample| !sample.inferred));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_sessions() {
        let source = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fixture(outside.path(), "ours.jsonl", "account-a", "pro", "primary");
        std::os::unix::fs::symlink(
            outside.path().join("sessions"),
            source.path().join("sessions"),
        )
        .unwrap();
        let (samples, status) = read(
            source.path(),
            "account-a",
            &json!("pro"),
            &json!({"buckets":[{"id":"codex","primary":{"windowDurationMins":10080}}]}),
            1791000000,
        );
        assert!(samples.is_empty());
        assert_eq!(status.files, 0);
    }

    #[test]
    fn oversized_lines_are_skipped_and_partial_lines_are_not_imported() {
        let bytes = format!("{}\nok\nunfinished", "x".repeat(LINE_CAP + 1));
        let mut reader = BufReader::new(bytes.as_bytes());
        let mut budget = BYTE_CAP;
        assert_eq!(line(&mut reader, &mut budget).unwrap(), Some(vec![]));
        assert_eq!(
            line(&mut reader, &mut budget).unwrap(),
            Some(b"ok\n".to_vec())
        );
        assert_eq!(line(&mut reader, &mut budget).unwrap(), None);
    }
}
