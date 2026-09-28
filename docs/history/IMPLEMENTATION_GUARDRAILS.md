# Codex Workbench — Implementation Guardrails & Edge Cases

> These rules exist to prevent a one-shot implementation from accidentally turning into a heavyweight IDE or an unsafe shell wrapper.

## 1. Hard "do not" list

Do **not**:

- use Electron;
- add an always-on Node.js backend/runtime;
- add a database in v1;
- recursively scan the entire repository on project open;
- recursively watch the entire repository;
- poll `git status`;
- keep Codex App Server alive forever when idle;
- start an LSP by default;
- start a terminal/PTY by default;
- create one CodeMirror instance per tab;
- eagerly bundle/load all CodeMirror languages;
- render unlimited command output into the DOM;
- expose `runShell(command: string)` to the frontend;
- use `sh -c`/`zsh -c` with user-generated command strings;
- silently auto-install missing linters/LSPs/packages;
- store ChatGPT/API credentials yourself when App Server login can own auth;
- display or invent hidden chain-of-thought;
- claim tests passed based on agent prose alone;
- overwrite a dirty file after an external disk change;
- follow symlinks outside the project root by default;
- execute Markdown HTML/scripts.

Any deviation requires an explicit documented reason.

---

## 2. Resource budget philosophy

Optimize **idle cost first**, then active latency.

### Idle

Expected work:

- no filesystem traversal;
- no Git process;
- no Codex process after timeout;
- no CodeMirror if no file is open;
- no Markdown renderer if not previewing;
- no timer firing at high frequency;
- no animated canvas/blur effects.

A one-second UI clock is unnecessary.

Use CSS for simple active indicators.

### Active

It is acceptable to use CPU/RAM while:

- Codex is working;
- a large diff is being parsed;
- a file is open;
- a user explicitly runs checks.

Return resources when the capability closes/completes.

---

## 3. Measure, don't guess

Add a small developer checklist/script for profiling:

- app cold launch;
- idle for 60 seconds;
- project open, no task;
- active Codex task;
- 10 logical file tabs;
- large command output;
- 5k-line diff;
- close editor/diff and verify memory settles.

Do not block release on a single absolute RSS number because WebView accounting differs by platform.

Do block regressions caused by obvious always-on work.

---

## 4. Tauri capability/security rules

Keep Tauri capabilities narrow.

The WebView should not have general permission to:

- run arbitrary executables;
- read arbitrary filesystem paths;
- write arbitrary filesystem paths.

Prefer custom Rust commands that:

- validate active project root;
- take structured arguments;
- return structured data.

If Tauri shell plugin is used internally, configure the smallest necessary command scope.

---

## 5. Path handling

Treat filesystem paths as untrusted input even though this is a personal app.

For project-relative operations:

```text
requested relative path
    ↓
join active project root
    ↓
normalize/canonicalize safely
    ↓
verify contained in project root
    ↓
operate
```

Special care:

- `../`;
- symlinks;
- case-insensitive filesystems;
- deleted path between validation and use;
- renamed files;
- filenames with spaces/newlines/unicode.

Never parse Git `-z` output by splitting on ordinary newlines.

---

## 6. File conflict safety

Every loaded editable file gets a fingerprint:

- last modified time if reliable;
- file size;
- optionally stronger content hash for dirty-save conflict if needed.

Before save, verify disk still matches expected fingerprint.

If not:

**Never overwrite automatically.**

Present:

- Compare
- Reload disk
- Keep editor content / Save As (if implemented)
- Cancel

This matters because Codex itself may edit the same file while the user is looking at it.

---

## 7. Codex and manual edit concurrency

If a user begins a manual edit during an active Codex turn:

- allow it, but display a subtle warning that Codex may also modify project files;
- dirty editor content must never be overwritten by a Codex file-change refresh;
- if Codex changes the same dirty file, raise conflict state immediately when detected.

Do not attempt automatic three-way merge in v1.

---

## 8. App Server compatibility

Codex App Server evolves.

Rules:

1. run the documented initialization handshake exactly once per connection;
2. use stable APIs unless the product explicitly needs an experimental one;
3. ignore unknown notification fields;
4. unknown methods should not crash;
5. regenerate schemas when changing the supported Codex CLI baseline;
6. do not hardcode a single model name;
7. use `model/list`;
8. use server-reported approval decisions/capabilities where available.

Developer helper:

```bash
codex app-server generate-ts --out ./schemas/codex
codex app-server generate-json-schema --out ./schemas/codex-json
```

Generated schemas are developer artifacts; avoid forcing end users to run schema generation.

---

## 9. App Server stdout/stderr

Protocol:

- stdout = JSONL protocol;
- stderr = logs/diagnostics.

Never merge stderr into stdout.

If a single stdout line is malformed:

- log a redacted sample in dev mode;
- continue if safe.

If malformed protocol repeats, mark connection unhealthy rather than spinning.

---

## 10. App Server request IDs

Request IDs must be unique within a connection.

After restart, reset or continue monotonically; either is fine because process generation distinguishes connections.

Never let a late response from an old generation resolve a request in the new generation.

---

## 11. Pending approval correctness

An approval is a server request, not a chat message.

Maintain a backend pending-request registry.

Only accept a UI decision when:

- request ID exists;
- process generation matches;
- request is unresolved;
- decision is valid for request type.

Remove it on:

- successful response;
- explicit server resolved notification;
- turn completion/cancellation if App Server clears it;
- process disconnect.

UI must disable stale decisions.

---

## 12. Network approval UX

When App Server reports network approval context, display:

- host;
- protocol;
- port if available;
- reason.

Do not rely on a shell command preview as the main explanation.

Do not turn a host-specific permission into a generic "allow internet" label.

---

## 13. Turn status truth

`turn/completed` is authoritative for terminal state.

Possible user-facing terminal outcomes:

- Completed
- Failed
- Interrupted
- Connection lost / Unknown until reconciled

If the child process dies mid-turn, do not label the turn `Failed` unless the server/history confirms that. Use `Connection lost` and reconcile after restart/resume.

---

## 14. Activity timeline truth

The UI may summarize multiple low-level events into one row, but the summary must remain factual.

Good:

`Read 12 files`

Bad:

`Understood authentication architecture`

unless Codex explicitly emitted that message.

Good:

`Running tests`

only when a command/tool event actually indicates a test command.

Do not infer "lint", "test", or "typecheck" purely from exit output unless command classification is obvious and retained.

---

## 15. Command display

Store command as structured args when App Server provides them.

For display, shell-escape only for human readability.

Never take the human-formatted string and execute it.

Show:

- exact displayed command;
- cwd;
- exit code;
- duration;
- stdout/stderr or combined output as actually available.

---

## 16. Large output protection

Set bounded memory limits.

Example policy:

- output preview in timeline: last ~8–20 KiB;
- backend retained command output: max ~1 MiB/item;
- mark truncation;
- max number of simultaneously retained completed command bodies may be LRU-limited.

Do not use exact values as magic scattered constants. Keep them in one config/constants module.

---

## 17. Large file protection

Avoid CodeMirror for pathological files by default.

Policy baseline:

- small text: normal;
- medium text: warn/read-only;
- huge text: metadata/external open;
- binary: unsupported preview.

Never stringify a 100 MB file into a Tauri JSON IPC response.

If future large-file support is added, it requires streaming/windowed reads.

---

## 18. Large diff protection

A turn can generate a huge diff.

Rules:

- parse file headers/summary first;
- render detailed hunks only for selected file;
- cap inspector preview;
- lazy-load full diff;
- virtualize if full diff is long;
- never mount split diff for every changed file.

---

## 19. Directory protection

Do not expand recursively.

Also guard directories with enormous immediate child counts:

- return paged or bounded entries if needed;
- surface "many files" state;
- never freeze WebView building 100k rows.

Generated folders remain hidden by default.

---

## 20. CodeMirror discipline

Do not import `basicSetup` and then add a second full bundle of features blindly.

Construct intentional extension sets for:

- read-only;
- edit;
- diff.

Use CodeMirror compartments/reconfiguration where appropriate.

Destroy the active view when the file workspace no longer needs it if measurements show meaningful savings.

No editor instance per tab.

---

## 21. Markdown safety

Minimum:

- raw HTML off;
- safe link protocol validation;
- no inline script;
- no iframe/object/embed;
- external links opened by controlled system action.

Local image preview is optional. If implemented, path must remain project-scoped.

---

## 22. No hidden indexing

Features that normally imply indexing must be explicit.

Do not add:

- fuzzy full-repo symbol index;
- semantic embeddings;
- AST index;
- background ripgrep crawl;
- file-content search index.

If project-wide search is implemented, run it on demand and stream results.

---

## 23. Language intelligence policy

Base v1:

- syntax parsing/highlighting is local to the open file;
- no always-on LSP;
- no automatic language-server installation.

Architecture may later add:

```text
Smart Mode ON
  → resolve existing project language server
  → start on demand
  → attach to editor
  → idle timeout
  → kill
```

But do not let this future interface complicate the v1 core.

For v1 project checks, Codex itself may run repo-native test/lint/typecheck commands as part of tasks; the UI should faithfully display those command results.

---

## 24. Git dirty workspace

Before a turn, the repository may already contain user changes.

Never assume:

`final git diff == Codex changes`

Capture baseline.

Use App Server file-change events to improve attribution.

If ambiguous, label it ambiguous.

Do not offer destructive revert/reset operations in v1.

---

## 25. Non-Git project

Must still support:

- file browsing;
- Codex tasks;
- App Server events;
- live App Server diff/file changes where available;
- manual editing.

Hide/disable branch and Git-ground-truth features.

Do not auto-initialize Git.

---

## 26. App lifecycle

### Window close while clean/idle

Exit normally and terminate owned children.

### Window close with dirty manual tabs

Confirm unsaved changes.

### Window close with active turn

Warn:

`Codex is still working. Quit and interrupt the current task?`

If user confirms:

- interrupt when possible;
- terminate owned App Server during teardown;
- do not hang forever waiting for graceful completion.

---

## 27. Logging

Production logs:

- lifecycle events;
- errors;
- high-level protocol method names;
- child exit codes.

Never log:

- auth tokens;
- API keys;
- entire source files;
- entire prompts by default;
- giant command output.

A developer debug mode may expose more locally, still redacting secrets.

---

## 28. No telemetry by default

This is a personal local developer tool.

Do not add analytics SDKs, crash-reporting SDKs, or remote telemetry in the initial implementation.

Local logs are sufficient.

---

## 29. Dependency discipline

Before adding a dependency ask:

1. Is it required?
2. Can platform/Rust/Svelte already do it?
3. Does it add a daemon/runtime?
4. Does it materially increase initial JS bundle?
5. Can it be dynamically imported?
6. Is it maintained?

Avoid bringing a large design system simply for buttons/popovers.

---

## 30. Build quality bar

One-shot implementation is not allowed to leave the core workflow as mock UI.

Core must be real:

- real project open;
- real file read/save;
- real Codex App Server child;
- real handshake;
- real thread/turn;
- real streamed events;
- real approvals;
- real diff;
- real Git refresh;
- real Markdown preview.

Mocks are for tests, not production fallback.

---

## 31. Definition of done

Before declaring complete:

- `npm/pnpm` frontend checks pass;
- Rust `cargo test` passes;
- Tauri app builds;
- fake App Server integration tests pass;
- no obvious background poll loops;
- app can launch without Codex installed and shows a graceful setup state;
- app can launch outside a Git repo;
- dirty-file conflict is protected;
- child processes terminate on exit;
- README contains local development and real Codex smoke-test steps.
