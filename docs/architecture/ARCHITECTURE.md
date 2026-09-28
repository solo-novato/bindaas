# Codex Workbench — Architecture

> **Authoritative for v1.** Prefer these boundaries over convenience shortcuts.
>
> Last aligned with the public Codex App Server documentation on 2026-09-14.

> The approved multi-harness extension is documented in [HARNESSES.md](HARNESSES.md). It adds the agent registry and optional native Claude CLI adapter while preserving the file/editor/process safety boundaries below.

## 1. Goals

1. Keep idle CPU/RAM usage minimal.
2. Make Codex activity highly observable.
3. Avoid reimplementing Codex's agent harness.
4. Keep the frontend incapable of arbitrary shell execution.
5. Make expensive functionality lifecycle-bound and disposable.
6. Keep the codebase small enough for a single developer to understand.

---

## 2. Chosen stack

### Desktop shell

- **Tauri 2**
- Rust backend/core process
- OS system WebView

Do not use Electron.

### Frontend

- **Svelte 5**
- TypeScript
- Vite
- plain CSS/CSS variables or a very small utility layer
- avoid heavyweight component frameworks unless already justified by implementation

### Editor

- **CodeMirror 6**
- dynamically imported
- one active EditorView for normal file editing
- `@codemirror/merge` only when full diff mode is opened

### Agent integration

- installed **Codex CLI**
- `codex app-server`
- default **stdio JSONL** transport

Do not integrate the raw model API for the coding agent workflow.

### Git

- system `git` executable
- short-lived commands
- no libgit2 requirement
- no polling loop

### Persistence

No database.

Persist only small app state/preferences in Tauri app config/data:

- recent projects;
- project → last thread id;
- pane sizes;
- appearance;
- last model/effort;
- optional Codex executable path;
- idle timeout.

Codex thread history remains owned by Codex/App Server.

---

## 3. Process model

```text
┌─────────────────────────────────────────────────────────────┐
│ System WebView / Svelte UI                                  │
│                                                             │
│ - task timeline                                             │
│ - project tree                                              │
│ - editor/diff                                               │
│ - approval UI                                               │
│ - settings                                                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ Tauri commands/events
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ Tauri Rust core                                             │
│                                                             │
│ ProjectService                                              │
│ FileService                                                 │
│ GitService                                                  │
│ SettingsService                                             │
│ CodexManager                                                │
│   └── AppServerClient                                       │
│       └── JSON-RPC request router / event normalizer         │
└───────────────────────┬──────────────────┬──────────────────┘
                        │                  │
               spawn on demand      short-lived commands
                        │                  │
                        ▼                  ▼
               codex app-server           git
               (child process)
```

Future/optional processes such as a PTY or language server must follow the same on-demand lifecycle pattern.

---

## 4. Trust boundary

### Frontend may

- request project/file actions through typed Tauri commands;
- request Codex operations;
- render normalized events;
- respond to approvals through a dedicated command.

### Frontend may not

- execute arbitrary shell strings;
- directly spawn processes;
- directly access unrestricted filesystem paths;
- write outside the active project root without a specific approved feature.

All process and filesystem authority lives in Rust.

---

## 5. Codex executable discovery

At startup, do **not** spawn Codex.

When Codex is first needed, resolve executable in this order:

1. explicit user-configured absolute path;
2. a Rust executable lookup (`which`-style lookup using current PATH);
3. known common platform locations where practical;
4. if not found, show the "Codex CLI not found" state and let the user select the executable.

Do not run user-controlled shell interpolation to discover it.

Validate that the selected path is a file/executable before saving it.

---

## 6. Codex App Server lifecycle

### States

```text
Stopped
  ↓ start requested
Starting
  ↓ child spawned
Initializing
  ↓ initialize + initialized successful
Ready
  ↓ process exits
Stopped / Failed
```

A process generation ID must distinguish events from an old process after a restart.

### Start

Spawn:

```text
codex app-server
```

using stdio pipes.

Keep:

- stdin writer;
- stdout line reader;
- stderr line reader;
- child handle;
- process generation;
- pending JSON-RPC requests.

### Protocol framing

Default stdio is newline-delimited JSON.

Each stdout line is one JSON message.

Never parse stderr as protocol messages.

### Required handshake

Immediately after connection:

1. send `initialize` with stable client metadata;
2. receive response;
3. send `initialized` notification;
4. only then send other requests.

Example logical metadata:

```json
{
  "clientInfo": {
    "name": "codex_workbench",
    "title": "Codex Workbench",
    "version": "<app version>"
  }
}
```

Stay on the stable App Server API by default. Do not enable `experimentalApi` merely because an experimental endpoint exists.

### Idle shutdown

Default configurable idle timeout: **5 minutes** after all of the following are true:

- no active turn;
- no pending approval/server request;
- no in-flight JSON-RPC request;
- no login flow in progress;
- no foreground screen operation that requires App Server.

On timeout:

1. mark UI as sleeping;
2. gracefully close stdin if safe;
3. terminate child if it does not exit in a short bounded grace period;
4. clear process-scoped pending state;
5. preserve thread IDs and rendered UI state.

Next Codex action starts a fresh App Server process and uses `thread/resume`.

Never terminate while a turn or approval is active.

---

## 7. Codex protocol use

Use App Server as the canonical agent orchestration layer.

### Required stable operations

At minimum support:

- initialization handshake;
- `model/list`;
- account/auth state needed by the UI;
- ChatGPT login start/completion flow;
- `thread/start`;
- `thread/resume`;
- `thread/list`;
- `thread/read` if required for history rendering;
- `turn/start`;
- `turn/interrupt`;
- item/turn notifications;
- server-initiated approval requests and responses.

Use `turn/steer` only if the UI intentionally exposes steering.

### Thread rules

- each project can remember a last active thread ID;
- create a new thread only from explicit user intent;
- use project root as `cwd`;
- resume stored thread after App Server restart;
- do not infer `sessionId`; use server-provided values when needed.

### Model list

Do not hardcode the model picker.

Call `model/list` and render picker-visible models/capabilities returned by App Server.

Cache the result for the current App Server process.

### App Server schema compatibility

The Codex CLI can generate version-specific TypeScript/JSON schemas:

```bash
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas
```

Include a developer script/documented workflow to regenerate protocol fixtures/types when upgrading supported Codex CLI behavior.

The production Rust boundary should still be tolerant:

- parse outer JSON-RPC envelope robustly;
- normalize only fields the UI needs;
- ignore unknown notification fields;
- log unknown methods in debug mode rather than crashing.

---

## 8. JSON-RPC client design

`AppServerClient` owns:

```text
next_request_id
pending_requests: HashMap<RequestId, oneshot sender>
stdin writer
child handle
process generation
notification broadcaster
pending server requests
```

### Responses

Message with `id` + `result/error`:

- locate pending request;
- resolve exactly once;
- unknown IDs are logged and ignored.

### Notifications

Message with `method` and no request ID:

- normalize to internal domain event where supported;
- unknown methods are debug-logged;
- frontend should not receive raw arbitrary protocol as its primary API.

### Server-initiated requests

A message from App Server requiring client response must be retained with:

- request ID;
- thread ID;
- turn ID;
- item ID if present;
- request type;
- decision options/payload.

Emit a normalized approval/request event to the UI.

UI response invokes:

```text
codex_respond_server_request(request_id, decision)
```

Rust validates the decision shape for the known request type and sends the JSON-RPC response.

### Backpressure / event batching

High-frequency deltas must not trigger one WebView state update per tiny chunk.

In Rust, coalesce:

- agent message deltas;
- command output deltas;
- rapidly repeated progress deltas;

into batches approximately every 30–60 ms or when a bounded byte threshold is reached.

Final `item/completed` remains authoritative.

---

## 9. Internal event model

Do not mirror every App Server wire type into the UI.

Normalize to a smaller stable model:

```text
AgentMessageDelta
ItemStarted
ItemUpdated
ItemCompleted
CommandStarted
CommandOutput
CommandCompleted
FileChangeStarted
FileChangeCompleted
TurnDiffUpdated
ApprovalRequested
ApprovalResolved
TurnStarted
TurnCompleted
ConnectionStateChanged
AuthStateChanged
```

Each event includes `thread_id` and `turn_id` when available so UI state cannot accidentally mix simultaneous/resumed sessions.

---

## 10. Diff strategy

### While turn is active

Prefer App Server's aggregate turn diff notification when available:

`turn/diff/updated`

Use it to power:

- live Changes count;
- per-file additions/deletions;
- current diff preview.

### After turn completes

If project is a Git repository:

1. run a fresh Git status/diff;
2. treat it as repository ground truth;
3. clearly distinguish pre-existing changes from turn-attributed changes when possible.

Important: a normal working tree may already be dirty before Codex starts.

Therefore capture a lightweight **baseline Git status/diff metadata** at turn start, then compare at completion.

Do not blindly label every dirty file as "changed by this turn."

For non-Git projects, use App Server file-change/diff events and label source accordingly.

---

## 11. GitService

No polling.

Run Git only on:

- project open;
- explicit refresh;
- turn start baseline;
- turn completion;
- explicit Changes view action;
- branch action, if implemented.

Suggested commands:

```text
git rev-parse --show-toplevel
git branch --show-current
git status --porcelain=v2 -z
git diff --no-ext-diff --unified=3
git diff --cached --no-ext-diff --unified=3
```

Pass arguments as an array, not concatenated shell strings.

Bound stdout size for pathological repositories and surface a "diff too large" state.

---

## 12. FileService

### Project root

All normal project file operations require an active normalized project root.

Before read/write:

1. canonicalize target where possible;
2. prevent `..` traversal;
3. reject paths outside project root;
4. do not follow symlink directories outside project root by default.

### Lazy directories

`list_directory(relative_path)` returns one level only.

Never recursively walk the whole repository for the basic tree.

### File size policy

Suggested defaults:

- `<= 1 MiB`: normal text open/edit;
- `1–5 MiB`: read-only by default with warning; editing requires explicit action;
- `> 5 MiB`: metadata view only; offer external open if safe;
- binary/NUL-heavy content: do not load into CodeMirror.

These are configurable constants, not user settings in v1.

### Encoding

v1 editing supports UTF-8 text.

If decoding fails:

- show hex/binary unsupported state;
- never rewrite the file through lossy decoding.

### Save

Use explicit save.

Prefer safe write pattern where practical:

1. write sibling temp file;
2. fsync/flush as appropriate;
3. atomic replace/rename.

Preserve newline style when detectable.

---

## 13. Editor architecture

### Dynamic load

The initial frontend bundle must not eagerly import all CodeMirror language packages.

When a supported file opens:

1. load base editor chunk;
2. determine language by extension/file name;
3. dynamic import language support;
4. create/reconfigure the single active editor.

### One active view

Normal file tabs are logical app tabs.

Maintain one mounted `EditorView`.

For inactive clean tabs keep:

```ts
{
  path,
  cursor,
  selection?,
  scrollTop,
  lastKnownMtime
}
```

Use a small LRU content cache (for example 3–5 clean text files) if measurements show it improves perceived latency without materially increasing memory.

Dirty inactive tabs retain unsaved text.

### View mode extensions

Only:

- line numbers;
- syntax highlighting;
- selection;
- search;
- minimal keymap;
- read-only state.

### Edit mode extensions

Add on demand:

- history;
- undo/redo;
- indentation;
- bracket matching/close brackets;
- search/replace;
- folding only if cheap/useful;
- language-local autocomplete only if provided cheaply.

No LSP in the base v1 process model.

---

## 14. Markdown architecture

Use a small Markdown renderer such as `markdown-it`.

Security defaults:

- raw HTML disabled;
- safe-link validation;
- external links open through controlled Tauri/system browser action;
- do not execute script/embed content;
- no Mermaid in v1.

Preview component is lazy-loaded.

---

## 15. External file changes

v1 deliberately has **no recursive filesystem watcher**.

Cases:

### Codex changes the active clean file

Codex event indicates a completed file change.

If active tab is clean:

- reread that file;
- preserve approximate cursor/scroll when possible;
- refresh view.

### Active file has unsaved manual edits

Do not overwrite.

Show:

`File changed on disk while you have unsaved edits`

Actions:

- Compare
- Keep mine
- Reload disk version

### Another external app changes a file

On window focus and before save:

- stat only currently open/dirty files;
- compare mtime/size;
- handle conflict.

Do not watch the entire repository just to detect this.

---

## 16. Command output storage

Current turn output may be large.

Use bounded buffers per command item.

Suggested behavior:

- retain first useful section + rolling tail in memory;
- cap raw retained output per command (e.g. 1 MiB default);
- mark truncation explicitly;
- UI initially renders only a bounded number of lines;
- expanded view can page through retained chunks.

Never allow an unbounded command log to grow the WebView DOM.

---

## 17. Settings

Small JSON settings schema, versioned:

```json
{
  "schemaVersion": 1,
  "appearance": "system",
  "codexExecutablePath": null,
  "codexIdleTimeoutSeconds": 300,
  "recentProjects": [],
  "projectState": {},
  "lastModel": null,
  "lastReasoningEffort": null,
  "paneSizes": {}
}
```

Migrations must be forward-safe.

Corrupt settings should fall back to defaults after backing up the bad file.

---

## 18. Security requirements

- no arbitrary shell API exposed to WebView;
- command args are structured arrays;
- filesystem access scoped to project;
- no remote code loading in UI;
- Markdown raw HTML disabled;
- approval requests rendered from authoritative App Server data;
- secrets/API keys never written to application logs;
- ChatGPT auth should use App Server's supported login flow rather than the app inventing token storage;
- no telemetry by default;
- no project content is uploaded anywhere except through the Codex workflow the user explicitly initiates.

---

## 19. Error recovery

### Child process dies

- reject all pending requests with connection-lost error;
- emit disconnected state;
- keep current UI state;
- do not infinite-loop restart;
- next explicit Codex action may restart.

### Malformed protocol line

- record redacted debug log;
- skip line;
- do not crash the UI;
- if repeated beyond a sane threshold, mark App Server unhealthy.

### Request timeout

Use operation-specific bounded timeouts for setup/list operations.

Do not impose a short generic timeout on active Codex turns.

### App close

Before window/app teardown:

- if a turn is active, ask before force quitting where platform UX permits;
- terminate owned child processes;
- flush settings;
- never orphan `codex app-server`.

---

## 20. Testing architecture

### Rust unit tests

- path containment;
- file-size/binary detection;
- JSON-RPC response routing;
- protocol event normalization;
- approval response validation;
- idle lifecycle state machine;
- Git porcelain parsing.

### Frontend unit/component tests

- timeline event rendering;
- approval card decision mapping;
- tabs/dirty-close behavior;
- changes list parsing;
- editor mode switching;
- Markdown link safety.

### Integration tests

Build a small **fake App Server executable/process fixture** that speaks JSONL and emits deterministic:

- initialize response;
- thread/start;
- turn/start;
- agent delta;
- command item;
- file-change item;
- approval request;
- turn diff;
- turn completed.

CI must not require a real ChatGPT login.

### Manual smoke test

With real Codex installed:

1. open fixture Git repo;
2. login/resume;
3. ask Codex to modify one file and run a command;
4. approve an action;
5. verify live diff;
6. verify completion;
7. close App Server after idle timeout;
8. send follow-up and verify thread resume.

---

## 21. External contract references

Use official current documentation when implementation details differ from this document:

- Codex App Server: https://learn.chatgpt.com/docs/app-server
- Tauri 2 architecture: https://v2.tauri.app/concept/architecture/
- Tauri process model: https://v2.tauri.app/concept/process-model/
- Tauri shell/process capability docs: https://v2.tauri.app/plugin/shell/
- CodeMirror docs: https://codemirror.net/docs/

If the live Codex version's generated schema conflicts with an example in these docs, prefer the generated schema for that installed Codex version while preserving the product behavior described here.
