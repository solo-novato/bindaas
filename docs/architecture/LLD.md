# Codex Workbench — Low-Level Design

> This document translates `PRODUCT.md`, `UX_SPEC.md`, and `ARCHITECTURE.md` into concrete modules, types, state machines, commands, and event flows.

## 1. Repository structure

Recommended:

```text
codex-workbench/
├── AGENTS.md
├── README.md
├── package.json
├── vite.config.ts
├── svelte.config.js
├── tsconfig.json
├── scripts/
│   └── generate-codex-schema.sh
├── docs/
│   ├── PRODUCT.md
│   ├── UX_SPEC.md
│   ├── ARCHITECTURE.md
│   ├── LLD.md
│   └── IMPLEMENTATION_GUARDRAILS.md
├── src/
│   ├── app.css
│   ├── App.svelte
│   ├── lib/
│   │   ├── api/
│   │   │   ├── tauri.ts
│   │   │   └── events.ts
│   │   ├── components/
│   │   │   ├── shell/
│   │   │   ├── chat/
│   │   │   ├── project/
│   │   │   ├── changes/
│   │   │   ├── editor/
│   │   │   ├── approvals/
│   │   │   └── common/
│   │   ├── editor/
│   │   │   ├── editorLoader.ts
│   │   │   ├── languageLoader.ts
│   │   │   ├── editorSession.ts
│   │   │   └── markdownRenderer.ts
│   │   ├── state/
│   │   │   ├── appState.svelte.ts
│   │   │   ├── projectState.svelte.ts
│   │   │   ├── codexState.svelte.ts
│   │   │   ├── editorState.svelte.ts
│   │   │   └── changesState.svelte.ts
│   │   ├── domain/
│   │   │   ├── project.ts
│   │   │   ├── codex.ts
│   │   │   ├── timeline.ts
│   │   │   ├── editor.ts
│   │   │   └── git.ts
│   │   └── utils/
│   └── routes/                 # optional if using a tiny route abstraction
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── commands.rs
        ├── state.rs
        ├── errors.rs
        ├── settings.rs
        ├── project/
        │   ├── mod.rs
        │   ├── service.rs
        │   └── paths.rs
        ├── files/
        │   ├── mod.rs
        │   ├── service.rs
        │   └── text.rs
        ├── git/
        │   ├── mod.rs
        │   ├── service.rs
        │   └── parser.rs
        └── codex/
            ├── mod.rs
            ├── manager.rs
            ├── app_server.rs
            ├── jsonrpc.rs
            ├── normalize.rs
            ├── approvals.rs
            └── lifecycle.rs
```

Do not create a generalized plugin framework in v1.

---

## 2. Core Rust application state

Conceptual shape:

```rust
struct AppState {
    settings: RwLock<Settings>,
    active_project: RwLock<Option<ProjectContext>>,
    codex: CodexManager,
}
```

### ProjectContext

```rust
struct ProjectContext {
    root: PathBuf,
    display_name: String,
    git: Option<GitProjectInfo>,
}
```

Only one active project is required in v1.

Opening another project replaces the active project after dirty-tab protection is handled by the frontend.

---

## 3. CodexManager

Responsibilities:

- resolve Codex executable;
- own process lifecycle;
- start App Server lazily;
- run initialization handshake;
- expose typed high-level operations;
- idle-shutdown scheduling;
- reconnect/restart;
- track active thread/turn metadata;
- ensure process cleanup.

Conceptual public methods:

```rust
impl CodexManager {
    async fn ensure_ready(&self) -> Result<()>;
    async fn list_models(&self) -> Result<Vec<ModelInfo>>;
    async fn read_account(&self) -> Result<AccountState>;
    async fn start_chatgpt_login(&self) -> Result<LoginStart>;
    async fn start_thread(&self, req: StartThread) -> Result<ThreadInfo>;
    async fn resume_thread(&self, thread_id: &str) -> Result<ThreadInfo>;
    async fn list_threads(&self, req: ThreadListRequest) -> Result<ThreadPage>;
    async fn start_turn(&self, req: StartTurn) -> Result<TurnInfo>;
    async fn interrupt_turn(&self, thread_id: &str, turn_id: &str) -> Result<()>;
    async fn respond_server_request(&self, req: ServerRequestResponse) -> Result<()>;
    async fn shutdown_if_idle(&self);
    async fn force_shutdown(&self);
}
```

All calls needing App Server invoke `ensure_ready()`.

---

## 4. AppServerClient

### Process members

Conceptually:

```rust
struct AppServerProcess {
    generation: u64,
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    pending_server_requests: Arc<Mutex<HashMap<u64, PendingServerRequest>>>,
}
```

Use an atomic monotonically increasing JSON-RPC request ID.

### Reader tasks

Spawn:

- stdout JSONL reader;
- stderr log reader;
- child exit waiter;
- delta coalescer if separate.

### Message envelope

Do not deserialize all possible App Server payloads into one giant enum.

First parse:

```rust
#[derive(Deserialize)]
struct RpcEnvelope {
    id: Option<serde_json::Value>,
    method: Option<String>,
    params: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<RpcError>,
}
```

Then route:

```text
id + result/error                 → response
method + id                       → server request
method without id                 → notification
otherwise                         → malformed
```

Normalize supported notifications by method name.

---

## 5. Internal Codex domain types

Frontend-facing types should be stable and small.

### Connection state

```ts
type CodexConnectionState =
  | { type: 'sleeping' }
  | { type: 'starting' }
  | { type: 'initializing' }
  | { type: 'ready' }
  | { type: 'disconnected'; message?: string }
  | { type: 'failed'; message: string };
```

### Turn status

```ts
type TurnStatus =
  | 'queued'
  | 'inProgress'
  | 'waitingForApproval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'connectionLost';
```

### Timeline item

```ts
type TimelineItem =
  | AgentMessageItem
  | CommandItem
  | FileChangeItem
  | ApprovalItem
  | ToolItem
  | StatusItem
  | WarningItem;
```

Common:

```ts
interface TimelineBase {
  id: string;
  threadId?: string;
  turnId?: string;
  startedAt?: number;
  completedAt?: number;
  status: 'inProgress' | 'completed' | 'failed' | 'declined';
}
```

### Command item

```ts
interface CommandItem extends TimelineBase {
  kind: 'command';
  command?: string[];
  displayCommand: string;
  cwd?: string;
  exitCode?: number;
  outputPreview: string;
  outputTruncated: boolean;
}
```

### File change

```ts
interface FileChangeItem extends TimelineBase {
  kind: 'fileChange';
  files: Array<{
    path: string;
    changeType?: 'added' | 'modified' | 'deleted' | 'renamed';
  }>;
  summary?: string;
}
```

### Approval

```ts
interface ApprovalItem extends TimelineBase {
  kind: 'approval';
  requestId: string;
  approvalType:
    'commandExecution' | 'fileChange' | 'permissions' | 'userInput' | 'unknown';
  title: string;
  reason?: string;
  command?: string[];
  cwd?: string;
  network?: {
    host?: string;
    protocol?: string;
    port?: number;
  };
  allowedDecisions: string[];
  resolvedDecision?: string;
}
```

A `thinking` activity may display Codex-provided reasoning summaries and item lifecycle state. Do not forward raw reasoning content or raw reasoning text deltas.

---

## 6. Tauri command surface

Keep the command surface explicit.

### Project

```text
project_pick_directory()
project_open(path)
project_get_active()
project_close()
```

`project_open` returns:

```ts
interface ProjectInfo {
  root: string;
  displayName: string;
  isGitRepository: boolean;
  gitRoot?: string;
  branch?: string;
}
```

### Files

```text
file_list_directory(relativePath)
file_read(relativePath)
file_save(relativePath, expectedFingerprint, content)
file_stat(relativePath)
file_reveal_in_system(relativePath)
```

`file_read`:

```ts
interface FileReadResult {
  path: string;
  content?: string;
  encoding: 'utf8' | 'binary' | 'unsupported';
  sizeBytes: number;
  newline: 'lf' | 'crlf' | 'mixed' | 'unknown';
  fingerprint: {
    modifiedMillis?: number;
    sizeBytes: number;
  };
  readOnlyRecommended: boolean;
}
```

`expectedFingerprint` protects against overwriting an externally changed file.

### Git

```text
git_summary()
git_status()
git_diff(scope?)
git_refresh()
```

No `git_poll`.

### Codex

```text
codex_get_state()
codex_get_models()
codex_get_account()
codex_start_chatgpt_login()
codex_cancel_login(loginId)
codex_list_threads(projectOnly, cursor?)
codex_start_thread(options)
codex_resume_thread(threadId)
codex_start_turn(threadId, prompt, context, options)
codex_interrupt_turn(threadId, turnId)
codex_respond_server_request(requestId, response)
codex_sleep_now()
```

The UI must not pass raw arbitrary App Server method names through a generic invoke method.

---

## 7. Tauri event surface

Use stable app-specific event names.

Examples:

```text
codex://connection
codex://turn-started
codex://turn-completed
codex://timeline-item
codex://timeline-update
codex://turn-diff
codex://approval-requested
codex://approval-resolved
codex://auth-updated
```

Payloads use frontend domain types, not raw protocol.

### Delta batching

`codex://timeline-update` can carry batched text/output increments:

```ts
interface TimelineDeltaBatch {
  itemId: string;
  appendText?: string;
  appendOutput?: string;
}
```

Frontend applies at most one store update per batch.

---

## 8. Frontend state

Use a few domain stores, not a global event bus with arbitrary payloads.

### `appState`

```ts
appearance;
activeView;
leftPaneOpen;
rightPaneOpen;
paneSizes;
```

### `projectState`

```ts
project;
expandedDirectories;
directoryEntriesByPath;
selectedPath;
```

Directory cache only contains folders the user actually expanded.

### `codexState`

```ts
connection;
account;
models;
activeThreadId;
activeTurnId;
threads;
timelineByThread;
pendingApprovals;
turnDiff;
```

### `editorState`

```ts
tabs;
activeTabId;
mode;
mountedEditor;
dirtyDocuments;
cleanContentLru;
```

### `changesState`

```ts
liveTurnDiff;
parsedLiveFiles;
gitBaseline;
finalGitState;
selectedChangedFile;
```

---

## 9. Tabs and editor session

### Tab type

```ts
interface FileTab {
  id: string;
  path: string;
  kind: 'text' | 'markdown' | 'binary' | 'unsupported';
  mode: 'view' | 'edit' | 'preview' | 'split';
  dirty: boolean;
  cursor?: { anchor: number; head: number };
  scrollTop?: number;
  fingerprint?: FileFingerprint;
}
```

### Open algorithm

```text
click file
  ↓
tab already open?
  yes → activate
  no  → create tab metadata
  ↓
file_read
  ↓
load CodeMirror chunk if text and not loaded
  ↓
load language chunk by extension
  ↓
mount/reconfigure one EditorView
```

### Switch algorithm

Before leaving active editor:

1. record selection;
2. record scroll;
3. if dirty, retain document text;
4. if clean, optionally put text in small LRU;
5. reconfigure/recreate the same EditorView for next file.

Do not keep one editor DOM per tab.

### Save algorithm

1. gather current text;
2. call `file_save(path, expectedFingerprint, content)`;
3. if fingerprint conflict:
   - do not overwrite;
   - show conflict UI;
4. on success:
   - update fingerprint;
   - mark clean.

---

## 10. Language loading

Create a map:

```ts
type LanguageLoader = () => Promise<LanguageSupport | null>;
```

Suggested v1 support when official/small packages are available:

```text
.ts .tsx .js .jsx
.json
.css
.html
.md
.py
.rs
.java
.sql
.yaml .yml
.xml
```

Unknown extensions → plain text.

Dynamic imports must be code-split by Vite.

Do not load every grammar at startup.

---

## 11. Markdown renderer

`markdownRenderer.ts`:

```ts
interface MarkdownRenderOptions {
  projectRoot: string;
  sourcePath: string;
}
```

Rules:

- `html: false`;
- safe protocols only;
- intercept link clicks;
- relative project Markdown links open inside the app where possible;
- relative local non-Markdown links select/open file;
- external `http(s)` links open in system browser after validation.

No arbitrary embedded HTML/script.

---

## 12. Diff parsing

Create a lightweight unified diff parser sufficient for:

- file path;
- status;
- additions/deletions;
- hunks;
- line ranges;
- individual line types.

Conceptual:

```ts
interface ParsedDiffFile {
  oldPath?: string;
  newPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}
```

Do not attempt to implement Git rename heuristics in TypeScript. Consume what Git/App Server reports.

For giant diffs, parse incrementally or cap preview and offer explicit full load.

---

## 13. Turn start flow

```text
User presses Send
    ↓
validate active project
    ↓
ensure CodexManager Ready
    ↓
ensure thread:
  - existing selected thread → resume if needed
  - otherwise thread/start with cwd = project root
    ↓
capture Git baseline if Git repo
    ↓
turn/start
    ↓
receive turn/started
    ↓
UI active state
    ↓
stream item / diff / approval events
    ↓
turn/completed
    ↓
run final Git refresh
    ↓
render completion summary
    ↓
start idle timer
```

The UI should display the user's message immediately, then reconcile with returned turn/thread IDs.

---

## 14. Thread history flow

On entering Runs/history:

1. if cached list is fresh enough for the current session, show it immediately;
2. wake App Server if necessary;
3. call `thread/list` filtered by current project `cwd` when supported;
4. paginate;
5. selecting a thread loads sufficient history via supported App Server read APIs;
6. do not copy entire history into a permanent app database.

---

## 15. Approval flow

```text
App Server server request
    ↓
Rust stores request as pending
    ↓
emit normalized approval event
    ↓
UI pins approval card
    ↓
user selects decision
    ↓
codex_respond_server_request
    ↓
Rust validates request is still pending + decision is allowed
    ↓
send JSON-RPC response
    ↓
serverRequest/resolved / item completed
    ↓
remove pending UI
```

Double-submission must be idempotently rejected in the app layer.

If a request has already been resolved by App Server, disable stale buttons.

---

## 16. Active command output

Backend output buffer:

```rust
struct BoundedOutput {
    max_bytes: usize,
    truncated: bool,
    // implementation may keep prefix + tail
}
```

Frontend item shows:

- last useful lines while running;
- `Show output`;
- explicit `Output truncated` marker.

Do not append unbounded output strings to a Svelte reactive variable.

---

## 17. Git baseline and attribution

At turn start store:

```ts
interface GitBaseline {
  head?: string;
  statusFingerprint: string;
  dirtyPaths: string[];
  capturedAt: number;
}
```

At completion, refresh status/diff.

UI labels:

- `Changed during task` when supported by App Server turn file-change events;
- `Pre-existing change` when path was dirty before turn and attribution is ambiguous.

Do not pretend exact hunk attribution is known if it is not.

---

## 18. Idle lifecycle

Activity that resets Codex idle timer:

- App Server request initiated;
- response received;
- active turn event;
- approval pending/resolved;
- login flow;
- thread history fetch.

Ordinary mouse movement in the app does **not** reset Codex idle timer.

State condition for sleep:

```text
activeTurn == null
AND pendingApprovals == 0
AND inflightRequests == 0
AND loginFlow == null
AND now - lastCodexActivity >= configuredTimeout
```

---

## 19. Performance-sensitive component rules

### Timeline

Use keyed items.

If timeline becomes long:

- render a virtualized list or window older events;
- keep latest active items mounted;
- collapsing output must remove heavy DOM nodes.

### Project tree

Only expanded directory nodes exist.

Do not flatten tens of thousands of undiscovered paths into a store.

### Editor

Destroy/reconfigure expensive view extensions when leaving corresponding mode.

### Changes

Only parse/render the selected file's detailed diff plus lightweight summary metadata for others.

---

## 20. Debug diagnostics

Provide a developer-only diagnostics panel behind an environment flag.

It may show:

- App Server process state/PID;
- in-flight request count;
- pending approval count;
- active thread/turn;
- last protocol method;
- UI event queue length;
- estimated buffered command-output bytes;
- current editor loaded language;
- Git operation in progress.

Never show secrets or auth tokens.

This panel is specifically to catch accidental always-on work.

---

## 21. Acceptance tests

At minimum automate these user journeys with mocks/components where practical:

### Journey A — first task

- open project;
- send task;
- App Server wakes;
- thread starts;
- turn starts;
- agent message streams;
- command appears;
- file changes appear;
- diff updates;
- turn completes.

### Journey B — approval

- command approval request appears;
- correct detail is visible;
- user accepts once;
- response is sent exactly once;
- item completes.

### Journey C — manual edit conflict

- open file;
- enter edit mode;
- change text;
- disk fingerprint changes;
- save refuses overwrite;
- Compare/Reload path appears.

### Journey D — idle sleep and resume

- completed turn;
- idle timer fires;
- App Server terminates;
- send follow-up;
- server restarts;
- thread resumes;
- follow-up turn succeeds.

### Journey E — giant output

- command emits > configured output cap;
- app stays responsive;
- truncation is explicit;
- completion still renders.

### Journey F — no Git

- open non-Git directory;
- Codex task works;
- Git UI gracefully disappears;
- live App Server file changes remain usable.
