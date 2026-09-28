# Implementation notes

Codex Workbench implements the handoff in a single Tauri 2 window. Svelte owns presentation and unsaved editor buffers. Rust owns project containment, atomic saves, system Git, settings, and the Codex process. The frontend has no shell or unrestricted filesystem plugin.

The protocol baseline is the locally generated Codex CLI 0.154.0 schema in `schemas/codex/`. The wire envelope is parsed tolerantly; supported items are normalized before IPC. Reasoning items and notifications are discarded. Unknown server requests receive a JSON-RPC method-not-found error and a visible warning instead of silently granting access.

Thread history uses the current paginated `thread/turns/list` and `thread/items/list` APIs, with metadata-only `thread/read` and `thread/resume`. History pages stay in memory; Codex remains the persisted source. A normal task uses `workspace-write`, `on-request`, and the user approval reviewer. Model choices come from `model/list`; omitting a model delegates the default to Codex.

Command and file approvals accept only the pending request's offered decisions, or the stable protocol's decision set when no list is provided. Permission requests return the exact requested permission profile or an empty grant. User input requests validate answers by question ID. Unsupported experimental tool requests are rejected explicitly.

File tabs share one mounted CodeMirror view. Clean inactive contents are released; dirty buffers retain their text. Files are UTF-8 only, capped at 5 MiB, with an explicit editing warning above 1 MiB. Directory listings return at most 2,000 immediate children. Quick open only searches discovered filenames.

Diffs are parsed into summary metadata and rendered in 160-line pages. Split mode uses the same unified hunk data in paired columns, avoiding another editor runtime. This is a hunk comparison, not a reconstruction of entire before/after documents. Git unstaged and staged changes are separate scopes. Untracked files have an explicit open-file action. Pre-existing dirty paths are labeled without claiming exact attribution.

The timeline keeps at most 400 normalized items, renders the latest 100 initially, and lets the user reveal earlier retained activity. Older persisted activity is available through Runs. Command previews are bounded to 20 KiB; up to 16 command bodies retain 1 MiB each for paged inspection. Aggregate diffs are capped at 4 MiB and explicitly labeled when truncated. Markdown HTML and remote image loading are disabled; safe links use controlled browser or project actions.

The idle scheduler is driven by notifications and a single deadline, not a polling loop. It protects active turns, approvals, requests, and login. On shutdown, stdin closes first, then the owned process is terminated after a bounded grace period. Unix child process groups are cleaned up as well. A disconnect preserves an unknown turn outcome until history reconciliation.

There is no terminal, LSP, recursive watcher, indexing service, telemetry, database, or separate application backend. Test fixtures use Node only as a development dependency. The native runtime is Rust, the system WebView, system Git, and the installed Codex CLI.

## Plan mode and attachments

The installed 0.154.0 contract requires `capabilities.experimentalApi = true` for `turn/start.collaborationMode`. This opt-in is specifically needed for the requested Plan mode feature. Both Plan and Code send an explicit mode with the resolved model/effort and `developer_instructions: null`, retaining Codex's built-in instructions. Plan deltas share the bounded text stream; final plan items remain authoritative. Planning is a collaboration mode, not a replacement sandbox policy.

`attachments_pick` grants access only to files selected through the native picker. `attachment_paste_image` accepts bounded clipboard bytes, never arbitrary filesystem paths. Rust stores private, content-addressed snapshots and registers opaque IDs for the current process. Turn submission accepts registered IDs only, verifies snapshot hashes and bounds, and produces `localImage` or text inputs. Text files up to 64 KiB are included inline; larger and binary files are referenced by their snapshot path and original name, so parsing depends on the tools available to Codex. No unrestricted read or shell API is exposed. Images are PNG/JPEG/GIF/WebP, capped at 10 MiB; other files at 20 MiB; each message at eight attachments/40 MiB. Disk storage is capped at 200 MiB and registration at 64 unique snapshots per app session. Snapshots persist for history references; old snapshots can be removed manually when their conversations no longer need them. Drafts themselves are not persisted across app restarts.

The native runtime remains unchanged. Browser tests cover the picker IPC, clipboard image handling, removing attachments, attachment-only turns, retry preservation, and queued draft isolation. `cargo run --manifest-path src-tauri/Cargo.toml --example composer_smoke -- /absolute/path/to/codex` explicitly exercises real Plan → Code behavior with a text token and a red PNG fixture. It creates temporary directories and never touches the selected Workbench project.

## Workspace restoration and chat

Workspace navigation uses versioned WebView local storage with at most 12 projects, 40 tabs and 200 expanded directories per project. A 250 ms event-driven debounce persists navigation changes, with a synchronous unload flush. File buffers and unsent drafts are excluded. Existing installations fall back to their latest Rust-persisted recent project. Restore opens the project, rebuilds lazy tab/tree metadata, and reads up to six recent turns of the remembered thread without starting a new turn. An unavailable project or file produces a recoverable error. Reopening the same project does not stop its server, and `resume_or_attach` reattaches to an already running owned thread without issuing `thread/resume`. Pending question/approval cards are reconstructed from the live registry.

Chat lazily imports the shared Markdown renderer; raw HTML stays escaped and remote images remain suppressed. HTTP(S) links use the controlled external opener; absolute local file links are accepted only under the active project and then pass normal Rust containment checks. Fenced code and complete messages can be copied, and replies can quote a message as visible context. Follow-ups preserve the previous exchanges within the existing 400-item bound. A ResizeObserver follows asynchronous Markdown layout only while the reader is following the latest activity.

Question cards show one question at a time with native radio semantics, choice descriptions, a freeform alternative, Back/Next navigation, and explicit final submission. Secret answers use a password field. The existing generation/request/answer validation remains authoritative, and failed submissions retain the answers.
