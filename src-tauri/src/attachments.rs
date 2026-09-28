use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_FILES: usize = 8;
pub const MAX_BYTES: usize = 20 * 1024 * 1024;
const STORE_CAP: u64 = 200 * 1024 * 1024;
const TEXT_PREVIEW_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Preview {
    Text {
        text: String,
        truncated: bool,
    },
    Image {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
    Unavailable {
        message: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub size_bytes: usize,
}

pub struct Store {
    root: PathBuf,
    entries: HashMap<String, Attachment>,
}

fn image_extension(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            entries: HashMap::new(),
        }
    }

    pub fn import_file(&mut self, path: &Path) -> Result<Attachment, String> {
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() > MAX_BYTES as u64 {
            return Err("Choose a regular file no larger than 20 MiB".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        self.import_bytes(
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("attachment"),
            &bytes,
            false,
        )
    }

    pub fn import_bytes(
        &mut self,
        name: &str,
        bytes: &[u8],
        image_only: bool,
    ) -> Result<Attachment, String> {
        if bytes.len() > MAX_BYTES {
            return Err("Attachments must be at most 20 MiB".into());
        }
        let image = image_extension(bytes);
        if image_only && image.is_none() {
            return Err("Paste a PNG, JPEG, GIF, or WebP image".into());
        }
        if image.is_some() && bytes.len() > 10 * 1024 * 1024 {
            return Err("Images must be at most 10 MiB".into());
        }
        if self.entries.len() >= 64 {
            return Err(
                "Attachment session limit reached. Restart Bindaas to attach more files.".into(),
            );
        }
        let name: String = Path::new(name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("attachment")
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        let file_extension = Path::new(&name)
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| {
                !s.is_empty() && s.len() <= 12 && s.bytes().all(|b| b.is_ascii_alphanumeric())
            })
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let extension = image.unwrap_or(&file_extension);
        // The content hash detects changed snapshots before sending, and deduplicates disk storage.
        let id = format!("{:x}.{extension}", Sha256::digest(bytes));
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let path = self.root.join(&id);
        if !path.exists() {
            let used: u64 = fs::read_dir(&self.root)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .sum();
            if used + bytes.len() as u64 > STORE_CAP {
                return Err(format!("Attachment storage reached 200 MiB. Remove unneeded snapshots from {} before attaching more.", self.root.display()));
            }
            let mut temp =
                tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
            temp.write_all(bytes).map_err(|e| e.to_string())?;
            temp.persist(&path).map_err(|e| e.to_string())?;
        }
        let entry = Attachment {
            id: id.clone(),
            name,
            kind: if image.is_some() { "image" } else { "file" }.into(),
            size_bytes: bytes.len(),
        };
        self.entries.insert(id, entry.clone());
        Ok(entry)
    }

    fn read_snapshot(&self, id: &str) -> Result<(&Attachment, Vec<u8>), String> {
        let entry = self
            .entries
            .get(id)
            .ok_or("Attachment expired. Attach the file again.")?;
        let file = fs::File::open(self.root.join(id))
            .map_err(|_| "Attachment missing. Attach the file again.")?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() != entry.size_bytes as u64 {
            return Err("Attachment changed. Attach the file again.".into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if bytes.len() > MAX_BYTES || !id.starts_with(&format!("{hash}.")) {
            return Err("Attachment changed. Attach the file again.".into());
        }
        Ok((entry, bytes))
    }

    pub fn preview(&self, id: &str) -> Result<Preview, String> {
        // Only registered attachment IDs are accepted; never arbitrary paths.
        let (entry, bytes) = self.read_snapshot(id)?;
        if entry.kind == "image" {
            let mime = match image_extension(&bytes) {
                Some("jpg") => "image/jpeg",
                Some("png") => "image/png",
                Some("gif") => "image/gif",
                Some("webp") => "image/webp",
                _ => return Err("Image format could not be recognized.".into()),
            };
            return Ok(Preview::Image {
                data_url: format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                ),
            });
        }
        let prefix = &bytes[..bytes.len().min(TEXT_PREVIEW_BYTES)];
        if !prefix.contains(&0) {
            let text = match std::str::from_utf8(prefix) {
                Ok(text) => Some(text),
                Err(error) if error.error_len().is_none() && bytes.len() > prefix.len() => {
                    std::str::from_utf8(&prefix[..error.valid_up_to()]).ok()
                }
                _ => None,
            };
            if let Some(text) = text {
                return Ok(Preview::Text {
                    text: text.into(),
                    truncated: text.len() < bytes.len(),
                });
            }
        }
        Ok(Preview::Unavailable {
            message: "Preview is available for text files and images. This file is still attached."
                .into(),
        })
    }

    pub fn input(&self, ids: &[String]) -> Result<Vec<Value>, String> {
        if ids.len() > MAX_FILES {
            return Err("Attach at most 8 files per message".into());
        }
        let mut input = vec![];
        let mut total = 0;
        for id in ids {
            let (entry, bytes) = self.read_snapshot(id)?;
            let path = self.root.join(id);
            total += bytes.len();
            if total > 40 * 1024 * 1024 {
                return Err("Attachments must total at most 40 MiB per message".into());
            }
            if entry.kind == "image" {
                input.push(json!({"type":"text","text":format!("Attached image: {}", entry.name),"text_elements":[]}));
                input.push(json!({"type":"localImage","path":path}));
            } else {
                let mut text = format!(
                    "Attached file (read-only snapshot): {}",
                    json!({"name":entry.name,"path":path})
                );
                // Small UTF-8 documents are usable immediately, even with restricted tool access.
                if bytes.len() <= 64 * 1024 && !bytes.contains(&0) {
                    if let Ok(content) = std::str::from_utf8(&bytes) {
                        text.push_str(&format!("\n<attached_file>\n{content}\n</attached_file>"));
                    }
                }
                input.push(json!({"type":"text","text":text,"text_elements":[]}));
            }
        }
        Ok(input)
    }

    pub fn claude_input(&self, ids: &[String]) -> Result<Vec<Value>, String> {
        let input = self.input(ids)?;
        let mut blocks = Vec::new();
        for block in input {
            if block["type"] == "text" {
                blocks.push(json!({"type":"text","text":block["text"]}));
            } else if block["type"] == "localImage" {
                let path = Path::new(block["path"].as_str().ok_or("Missing attachment path")?);
                let id = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or("Invalid attachment")?;
                let (_, bytes) = self.read_snapshot(id)?;
                let mime = match image_extension(&bytes) {
                    Some("jpg") => "image/jpeg",
                    Some("png") => "image/png",
                    Some("gif") => "image/gif",
                    Some("webp") => "image/webp",
                    _ => return Err("Unsupported image".into()),
                };
                blocks.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}}));
            }
        }
        Ok(blocks)
    }
}
