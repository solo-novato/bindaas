use bindaas::{
    attachments::{Store, MAX_BYTES},
    codex::input::{turn_params, Mode},
};
use serde_json::json;

#[test]
fn attachments_are_snapshots_and_images_use_native_input() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::new(temp.path().join("attachments"));
    let source = temp.path().join("notes.md");
    std::fs::write(&source, "Original brief").unwrap();
    let doc = store.import_file(&source).unwrap();
    std::fs::write(&source, "Changed after attaching").unwrap();
    let image = store
        .import_bytes("screen.png", b"\x89PNG\r\n\x1a\nfixture", true)
        .unwrap();
    let input = store.input(&[doc.id.clone(), image.id]).unwrap();
    assert!(input[0]["text"]
        .as_str()
        .unwrap()
        .contains("Original brief"));
    assert!(!input[0]["text"]
        .as_str()
        .unwrap()
        .contains("Changed after attaching"));
    assert_eq!(input[2]["type"], "localImage");
    assert!(std::path::Path::new(input[2]["path"].as_str().unwrap()).exists());
    assert!(store.input(&["../../secrets".into()]).is_err());
    std::fs::write(temp.path().join("attachments").join(&doc.id), "tampered").unwrap();
    assert!(store.input(&[doc.id]).unwrap_err().contains("changed"));
}

#[test]
fn attachment_limits_and_binary_references_are_explicit() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::new(temp.path().join("attachments"));
    assert!(store
        .import_bytes("huge.txt", &vec![0; MAX_BYTES + 1], false)
        .is_err());
    assert!(store
        .import_bytes("fake.png", b"not an image", true)
        .is_err());
    assert!(store.import_file(temp.path()).is_err());
    let pdf = store
        .import_bytes("brief.pdf", b"%PDF-1.7\0binary", false)
        .unwrap();
    assert!(pdf.id.ends_with(".pdf"));
    let input = store.input(std::slice::from_ref(&pdf.id)).unwrap();
    assert!(input[0]["text"].as_str().unwrap().contains("brief.pdf"));
    assert!(!input[0]["text"].as_str().unwrap().contains("binary"));
    assert!(store.input(&vec![pdf.id; 9]).is_err());
}

#[test]
fn plan_and_code_use_builtin_modes_with_resolved_model_and_effort() {
    let input = vec![json!({"type":"localImage","path":"/snapshot.png"})];
    let plan = turn_params(
        "thread",
        "Inspect this",
        input.clone(),
        Mode::Plan,
        "discovered-model",
        Some("high"),
    );
    assert_eq!(
        plan["collaborationMode"],
        json!({"mode":"plan","settings":{"model":"discovered-model","reasoning_effort":"high","developer_instructions":null}})
    );
    assert_eq!(plan["input"][1], input[0]);
    assert_eq!(plan["summary"], "auto");
    let code = turn_params("thread", "", input, Mode::Default, "discovered-model", None);
    assert_eq!(
        code["collaborationMode"]["mode"], "default",
        "Switching back explicitly clears previous plan mode"
    );
    assert_eq!(
        code["input"].as_array().unwrap().len(),
        1,
        "Attachment-only turns are supported"
    );
    assert_eq!(code["summary"], "auto");
    assert!(serde_json::from_value::<Mode>(json!("unknown")).is_err());
}

#[test]
fn unchanged_composer_requests_summaries_and_defers_thread_settings() {
    let params =
        bindaas::codex::input::turn_overrides("thread", "continue", vec![], None, None, None);
    assert_eq!(params.as_object().unwrap().len(), 3);
    assert_eq!(params["summary"], "auto");
    assert!(params.get("model").is_none());
    assert!(params.get("effort").is_none());
    assert!(params.get("collaborationMode").is_none());
    let model_only = bindaas::codex::input::turn_overrides(
        "thread",
        "continue",
        vec![],
        None,
        Some("chosen"),
        None,
    );
    assert_eq!(model_only["model"], "chosen");
    assert!(model_only.get("collaborationMode").is_none());
    assert!(model_only.get("effort").is_none());
}

#[test]
fn previews_use_verified_snapshots_and_bound_text_at_utf8_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::new(temp.path().join("attachments"));
    let original = temp.path().join("brief.md");
    std::fs::write(&original, "<script>literal text</script>").unwrap();
    let entry = store.import_file(&original).unwrap();
    std::fs::write(&original, "new source content").unwrap();
    let preview = serde_json::to_value(store.preview(&entry.id).unwrap()).unwrap();
    assert_eq!(preview["kind"], "text");
    assert_eq!(preview["text"], "<script>literal text</script>");
    assert_eq!(preview["truncated"], false);
    let large = format!("{}€ tail", "x".repeat(64 * 1024 - 1));
    let large = store
        .import_bytes("large.txt", large.as_bytes(), false)
        .unwrap();
    let preview = serde_json::to_value(store.preview(&large.id).unwrap()).unwrap();
    assert_eq!(preview["truncated"], true);
    assert_eq!(preview["text"].as_str().unwrap().len(), 64 * 1024 - 1);
    assert!(store.preview("../../brief.md").is_err());
    std::fs::write(
        temp.path().join("attachments").join(&entry.id),
        "<script>changed text</script>",
    )
    .unwrap();
    assert!(store.preview(&entry.id).unwrap_err().contains("changed"));
}

#[test]
fn image_and_binary_previews_preserve_attachment_input() {
    use base64::Engine;
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::new(temp.path().join("attachments"));
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=").unwrap();
    let image = store.import_bytes("pixel.png", &png, true).unwrap();
    let before = store.input(std::slice::from_ref(&image.id)).unwrap();
    let preview = serde_json::to_value(store.preview(&image.id).unwrap()).unwrap();
    assert_eq!(preview["kind"], "image");
    let encoded = preview["dataUrl"]
        .as_str()
        .unwrap()
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
        png
    );
    assert_eq!(before, store.input(&[image.id]).unwrap());
    let binary = store
        .import_bytes("data.bin", &[0, 255, 23], false)
        .unwrap();
    let preview = serde_json::to_value(store.preview(&binary.id).unwrap()).unwrap();
    assert_eq!(preview["kind"], "unavailable");
    assert!(preview.get("text").is_none());
    assert!(preview.get("dataUrl").is_none());
}
