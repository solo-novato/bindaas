# Resource profiling checklist

Use the native app and Activity Monitor. Filter processes by `codex-workbench`, its WebView, and `codex app-server`. Record CPU and memory separately; shared WebView memory accounting varies by OS.

1. Cold launch: verify no Codex or Git process is started by the empty screen. Record time to first usable window.
2. Leave idle for 60 seconds: CPU should settle; there should be no repeating Git, directory-read, or model-list operations.
3. Open a project without a task: only the root directory and one Git snapshot are requested. Expand one directory and confirm only that level is read.
4. Send a task: inspect streamed messages, command output, approvals, and diff updates. The UI clock updates every five seconds only while active.
5. Open ten file tabs: only one `.cm-editor` exists. Clean inactive tabs retain metadata. Switch to Chat and confirm the editor is destroyed.
6. Set idle timeout to five seconds. Complete a task and verify the App Server exits. Send a follow-up and confirm a new process generation resumes the same thread.
7. Use the fake App Server's `huge` prompt: it emits more than 2 MiB of command output. The preview and retained bodies stay within their limits and completion remains visible.
8. Inspect a 5,000-line diff: only 160 detail lines appear at once. Page forward, switch to split mode, then close the inspector.
9. Close editor/diff views and wait: memory should settle rather than grow after repeated open/close cycles. Some WebView caching is expected.
10. Quit during a task and confirm: the owned App Server and its process group must terminate. Repeat with dirty tabs and cancel; the buffer must remain.

For local diagnostics launch with `VITE_DIAGNOSTICS=1 npm run desktop`, then expand Developer diagnostics in Settings. It includes connection and active IDs, pending approval count, retained timeline preview size, active editor path, and Git operation state. It does not expose credentials or raw protocol payloads.

## Current evidence and limits

The September 21 native process samples are in `ux/native-process-sample.json` and `ux/native-process-second-sample.json`. They cover two 60-second intervals of the open app, separating the native core and its owned child processes. They exclude OS-hosted WebKit processes where ownership could not be established; they are not a full application memory benchmark or proof of all checklist steps.

The opt-in `live_idle` Rust integration test in the README verifies production-manager idle shutdown, child reaping, and fresh connection startup against installed Codex, with an ephemeral read-only thread and no model turn. It passed with CLI 0.155.0. The regular fixture suite separately covers active-turn/approval protection and restart/resume. The full native UI workflow, editor/diff close-and-settle profile, and observed restored-workspace idle transition remain pending. macOS Accessibility automation currently reports disabled, so native interaction evidence must not be inferred from browser fixture results.
