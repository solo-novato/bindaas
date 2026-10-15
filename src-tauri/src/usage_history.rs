//! Local account-limit observations. Never store credentials or conversation content.
mod import;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Write, path::Path};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: u64,
    pub bucket: String,
    pub minutes: u64,
    pub reset: u64,
    pub used: f64,
    #[serde(default)]
    pub inferred: bool,
}
#[derive(Default, Deserialize, Serialize)]
struct History {
    accounts: BTreeMap<String, Vec<Sample>>,
    #[serde(default)]
    imports: BTreeMap<String, ImportStatus>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportStatus {
    pub at: u64,
    pub files: usize,
    pub observations: usize,
    pub limited: bool,
    #[serde(default)]
    pub legacy_files: usize,
    #[serde(default)]
    pub unattributed_files: usize,
    #[serde(default)]
    pub revision: u32,
}

pub fn record(
    path: &Path,
    account: &Value,
    limits: &Value,
    at: u64,
) -> Result<Vec<Sample>, String> {
    record_with_history(path, account, limits, at, None).map(|(samples, _)| samples)
}

pub fn record_with_history(
    path: &Path,
    account: &Value,
    limits: &Value,
    at: u64,
    source: Option<&Path>,
) -> Result<(Vec<Sample>, Option<ImportStatus>), String> {
    // Prefer the snapshot account ID; older protocols only expose email.
    // Keep plans separate: a percentage has a different meaning after an upgrade.
    let Some(identity) = account["usageIdentity"]
        .as_str()
        .or_else(|| account["email"].as_str())
        .filter(|s| !s.is_empty())
    else {
        return Ok((vec![], None));
    };
    if account["type"] != "chatgpt" || limits.is_null() {
        return Ok((vec![], None));
    }
    let key = format!(
        "{:x}",
        Sha256::digest(format!("{}\0{}", identity, account["planType"]))
    );
    let mut history: History = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
            "Usage history could not be read; the existing file was preserved".to_string()
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => History::default(),
        Err(e) => return Err(format!("Usage history could not be read: {e}")),
    };
    let import_status = if let (Some(source), Some(id)) =
        (source, account["usageIdentity"].as_str())
    {
        // Import on first use and on the first usage read of a new day. No watcher,
        // polling, background indexing or repeated full scan on each token event.
        if history
            .imports
            .get(&key)
            .is_none_or(|s| s.at / 86400 != at / 86400 || s.revision != import::REVISION)
        {
            let (mut imported, status) = import::read(source, id, &account["planType"], limits, at);
            let stored = history.accounts.entry(key.clone()).or_default();
            // Re-evaluate profile attribution on every import; new account evidence
            // can invalidate legacy samples imported earlier.
            stored.retain(|s| !s.inferred);
            imported.append(stored);
            imported.sort_by(|a, b| {
                a.at.cmp(&b.at)
                    .then(a.bucket.cmp(&b.bucket))
                    .then(a.inferred.cmp(&b.inferred))
                    .then(b.used.total_cmp(&a.used))
            });
            imported.dedup_by(|a, b| {
                a.at == b.at && a.bucket == b.bucket && a.minutes == b.minutes && a.reset == b.reset
            });
            for sample in imported {
                compact_push(stored, sample);
            }
            history.imports.insert(key.clone(), status);
        }
        history.imports.get(&key).cloned()
    } else {
        None
    };
    let samples = history.accounts.entry(key).or_default();
    if let Some(buckets) = limits["buckets"].as_array() {
        for bucket in buckets {
            let id = bucket["id"]
                .as_str()
                .or_else(|| bucket["name"].as_str())
                .unwrap_or("default");
            for slot in ["primary", "secondary"] {
                let w = &bucket[slot];
                let (Some(used), Some(minutes), Some(reset)) = (
                    w["usedPercent"].as_f64(),
                    w["windowDurationMins"].as_u64(),
                    w["resetsAt"].as_u64(),
                ) else {
                    continue;
                };
                if !used.is_finite()
                    || !(0.0..=100.0).contains(&used)
                    || minutes == 0
                    || reset <= at
                {
                    continue;
                }
                let sample = Sample {
                    at,
                    bucket: format!("{id}:{slot}"),
                    minutes,
                    reset,
                    used,
                    inferred: false,
                };
                compact_push(samples, sample);
            }
        }
    }
    let result = samples.clone();
    let parent = path.parent().ok_or("Usage history folder unavailable")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, &history).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok((result, import_status))
}

fn compact_push(samples: &mut Vec<Sample>, sample: Sample) {
    let recent: Vec<usize> = samples
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, s)| s.bucket == sample.bucket)
        .take(2)
        .map(|(i, _)| i)
        .collect();
    if let Some(&last) = recent.first() {
        if samples[last].at >= sample.at {
            return;
        }
        // Preserve each hour's first/last observations and every reset/correction.
        if recent.len() == 2
            && recent.iter().all(|&i| {
                let s = &samples[i];
                s.at / 3600 == sample.at / 3600
                    && s.reset == sample.reset
                    && s.minutes == sample.minutes
                    && s.inferred == sample.inferred
                    && s.used <= sample.used
            })
            && samples[recent[1]].used <= samples[last].used
        {
            samples.remove(last);
        }
    }
    samples.push(sample);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn account(email: &str, plan: &str) -> Value {
        json!({"type":"chatgpt","email":email,"planType":plan})
    }
    fn limits(used: f64) -> Value {
        json!({"buckets":[{"id":"codex","primary":{"usedPercent":used,"windowDurationMins":300,"resetsAt":20000}}]})
    }
    #[test]
    fn persists_compacts_and_isolates_accounts_and_plans() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        for at in [100, 200, 300] {
            record(&path, &account("a", "pro"), &limits(at as f64 / 10.0), at).unwrap();
        }
        let saved = record(&path, &account("a", "pro"), &limits(40.0), 400).unwrap();
        assert_eq!(saved.iter().map(|s| s.at).collect::<Vec<_>>(), [100, 400]);
        assert_eq!(
            record(&path, &account("b", "pro"), &limits(1.0), 500)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            record(&path, &account("a", "plus"), &limits(1.0), 500)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            record(&path, &account("a", "pro"), &limits(50.0), 3700)
                .unwrap()
                .len(),
            3
        );
        assert!(!fs::read_to_string(path).unwrap().contains("email"));
    }
    #[test]
    fn corrections_are_retained_and_corrupt_history_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        for (at, used) in [(100, 20.0), (200, 10.0), (300, 15.0)] {
            record(&path, &account("a", "pro"), &limits(used), at).unwrap();
        }
        assert_eq!(
            record(&path, &account("a", "pro"), &limits(16.0), 400)
                .unwrap()
                .len(),
            3
        );
        fs::write(&path, "broken").unwrap();
        assert!(record(&path, &account("a", "pro"), &limits(20.0), 500).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
    }
}
