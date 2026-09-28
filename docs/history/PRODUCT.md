# Codex Workbench — Product Specification

> Working name only. The product may be renamed without changing the architecture.
>
> **Status:** Implementation-authoritative v1 specification  
> **Primary user:** A developer who delegates most coding to Codex, rarely edits code manually, but wants excellent visibility and control.

## 1. Product thesis

Traditional IDEs are optimized around a human continuously typing code. This product is not.

Codex Workbench is an **agent-first development environment** where:

1. the user describes intent;
2. Codex inspects, edits, runs commands, and validates the repository;
3. the app makes that work observable in real time;
4. the user reviews changes, asks follow-ups, intervenes when needed, and occasionally opens or edits files.

The primary surface is therefore **the task / Codex activity**, not the text editor.

A successful v1 should feel closer to a **developer control room** than a VS Code clone.

---

## 2. Non-negotiable product principles

### 2.1 Agent-first, editor-second

The default workflow is:

```text
Describe task
    ↓
Observe Codex working
    ↓
Inspect commands / files / changes
    ↓
Review final diff + checks
    ↓
Ask follow-up or continue
```

Opening and manually editing source files is a secondary workflow.

### 2.2 Maximum useful visibility

The user should never have to wonder:

- Is Codex still working?
- What is it doing right now?
- Which files has it touched?
- What commands has it run?
- Did the command pass or fail?
- Is it waiting for me?
- What permission is it asking for?
- What is the current diff?
- Did tests/type-check/lint pass?
- Did the turn complete, fail, or get interrupted?

Show **observable agent activity**, tool use, commands, file changes, approvals, progress, and final results.

Do **not** fabricate or expose hidden chain-of-thought. "Maximum visibility" means maximum visibility into real actions and explicit agent messages, not private reasoning traces.

### 2.3 Quiet when idle

When the user is not actively using a capability, it should consume as close to zero CPU as practical.

Do not keep background services alive simply because a normal IDE would.

### 2.4 Progressive capability

Capabilities wake only when intent justifies them.

Examples:

- CodeMirror loads only when a file is opened.
- Codex App Server starts only when Codex functionality is needed.
- Git runs on meaningful events rather than polling.
- Terminal/PTY does not exist until explicitly opened.
- Language servers are not a v1 always-on dependency.
- Markdown rendering loads only for Markdown preview.

### 2.5 User control over side effects

Commands, filesystem changes, permissions, and network approvals coming from Codex must be surfaced clearly when the App Server requires approval.

Approval UI must explain **what is being requested and why**, not just show a generic "Allow" button.

### 2.6 Ground truth over decorative intelligence

Prefer facts directly reported by:

- Codex App Server events,
- filesystem reads,
- Git,
- process exit codes,
- actual test/lint/typecheck output.

Avoid inventing task steps or inferred progress that is not backed by an observable event.

---

## 3. Target user and jobs to be done

### Primary user

A technically strong developer who:

- trusts Codex to perform most implementation work;
- wants to stay aware of what the agent is doing;
- frequently reviews diffs rather than typing code;
- sometimes opens files to understand context;
- occasionally needs a small manual edit;
- values low CPU/RAM use;
- does not want a heavyweight IDE running all day.

### Core jobs

The product must let the user:

1. Open a local repository.
2. Start or resume a Codex conversation for that repository.
3. Give Codex a task.
4. See live agent activity in a human-readable timeline.
5. See files changed during the turn.
6. Inspect current and final diffs.
7. See commands and their output/status.
8. Approve or decline actions when requested.
9. Interrupt an active turn.
10. Ask a follow-up in the same thread.
11. Open any project file quickly.
12. View code with syntax highlighting.
13. Make and save a small manual edit.
14. Preview Markdown.
15. Review previous Codex threads for the current project.
16. Understand whether the app/Codex is idle, working, waiting, failed, or disconnected.

---

## 4. Information architecture

Desktop-first layout:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Project / branch        Chat  Files  Changes  Runs       Agent status     │
├──────────────────┬──────────────────────────────────┬──────────────────────┤
│                  │                                  │                      │
│ PROJECT TREE     │ MAIN SURFACE                     │ CONTEXT INSPECTOR    │
│                  │                                  │                      │
│ Lazy directory   │ Chat/task timeline by default   │ Live changed files   │
│ navigation       │                                  │ Current diff         │
│                  │ File/editor when opened          │ Command detail       │
│                  │                                  │ Approval detail      │
│                  │ Full diff when requested         │ Preview/history      │
│                  │                                  │                      │
├──────────────────┴──────────────────────────────────┴──────────────────────┤
│ Prompt composer / context chips / model + effort / Send or Stop           │
└────────────────────────────────────────────────────────────────────────────┘
```

### Primary navigation

- **Chat** — active/past Codex thread and task activity.
- **Files** — focused file browsing/editor workspace.
- **Changes** — consolidated turn/repository diff.
- **Runs** — recent turns, status, duration, checks, failures.
- **Settings** — Codex executable, idle timeout, appearance, project preferences.

Navigation must not create separate heavyweight editor instances.

---

## 5. Main Chat UX

### 5.1 Idle state

Show:

- project name + path;
- Git branch if available;
- clear `Ready` / `Codex sleeping` state;
- latest thread if one exists;
- prompt composer;
- recent tasks;
- optional hint: "Codex will start when you send a task."

Do not start the Codex process simply to animate an idle screen.

### 5.2 Active task header

For an active turn show a persistent task card with:

- original user prompt;
- `In progress`, `Waiting for approval`, `Completed`, `Failed`, or `Interrupted`;
- elapsed time;
- selected model and reasoning effort if known;
- current working directory;
- current sandbox/permission mode if known;
- `Stop` action while active.

Do not show fake ETA.

### 5.3 Activity timeline

Normalize App Server events into compact, inspectable timeline rows.

Examples:

```text
✓ Inspected project structure                  12 files
✓ Read src/auth/session.ts
✓ Ran pnpm test                               exit 0 · 8.2s
● Editing src/middleware/rateLimit.ts
! Permission required                         network → redis.example.com
✓ Modified 4 files                            +182 −14
```

Each row can expand to show authoritative detail:

- command string;
- working directory;
- stdout/stderr;
- file path(s);
- patch/diff;
- error;
- approval reason;
- timing.

The default timeline is concise. Detail is one click away.

### 5.4 Agent messages

Render streamed agent messages naturally in the timeline/chat.

Do not mix low-level command output into normal prose unless expanded.

### 5.5 Waiting/approval state

Approval cards are visually prominent and pinned until resolved.

For command approval show:

- command;
- cwd;
- stated reason;
- permission/network details when provided;
- actions returned by App Server, e.g. Accept, Accept for session, Decline, Cancel.

For file-change approval show:

- affected files;
- reason;
- proposed root/grant if provided;
- diff link.

Network-specific approvals should emphasize destination host/protocol instead of pretending they are ordinary shell commands.

### 5.6 Completion state

At turn completion render a deterministic result card:

```text
Completed in 2m 41s

Changes
  4 files changed · +182 −14

Checks
  ✓ pnpm test
  ✓ pnpm typecheck
  ⚠ lint not run

Agent result
  <final Codex response>

[Review changes] [Continue task]
```

Only claim a check passed if there is an actual successful command/event supporting it.

---

## 6. Right-side context inspector

During an active or completed turn, the right inspector prioritizes:

### Changes list

```text
M src/middleware/rateLimit.ts  +120 -0
M src/api/index.ts             +8   -2
A tests/rateLimit.test.ts      +86  -0
M README.md                    +12  -1
```

Update from live turn diff/events while the turn is active.

After the turn ends, use Git diff as ground truth when the project is a Git repository.

### Diff preview

Click a changed file to show the relevant diff without leaving Chat.

Offer:

- Unified
- Split/full diff
- Open file
- Ask Codex about this change

### Contextual actions

Selection/file/hunk-aware actions may create a prepared prompt, for example:

- Explain this change
- Why is this necessary?
- Check this for regressions
- Rework this approach
- Revert this hunk (future unless safely implemented)

Do not silently execute a new turn from a contextual action; the user should see what will be sent.

---

## 7. File UX

### 7.1 Lazy project tree

- Read a directory only when it is expanded.
- Do not recursively index the repository.
- Directories first, then files.
- Hide known heavy/generated folders by default.
- Provide "Show hidden/generated" when needed.

### 7.2 Tabs

Support multiple logical tabs:

```text
auth.ts   user.ts ●   README.md   ×
```

But keep **one mounted CodeMirror EditorView** for the active text file.

Inactive clean tabs store minimal navigation state rather than a live editor instance.

### 7.3 Modes

#### View mode — default

- read-only;
- line numbers;
- syntax highlighting;
- selection;
- search;
- lightweight navigation;
- `Edit` action.

#### Edit mode — explicit

- cursor/editing;
- undo/redo;
- indentation;
- bracket matching/closing;
- search/replace;
- save;
- optional local completion supplied by CodeMirror language support.

Do not start a language server merely because Edit mode opened.

#### Markdown preview

For `.md`/`.markdown`:

```text
[Edit] [Preview] [Split]
```

Preview should support:

- headings;
- lists;
- links;
- tables;
- fenced code;
- task lists if supported by chosen Markdown package.

Raw HTML is disabled by default.

#### Diff mode

Use an on-demand diff/merge component. It must not remain mounted when no diff is visible.

### 7.4 Ask about code

When text is selected, show a small action:

`Ask Codex about selection`

The prompt must include:

- file relative path;
- selected line range;
- selected text;
- user's question.

---

## 8. Runs/history

The Runs screen should answer:

- What did I ask?
- When?
- How long did it run?
- Did it complete?
- How many files changed?
- What failed?
- Which thread was it part of?

Use Codex App Server persisted threads as the source of truth for Codex history when available.

Do not build a parallel full conversation database in v1.

A tiny app preference/state file may store:

- recent project roots;
- last active thread ID per project;
- UI preferences;
- last selected model/effort;
- Codex executable override;
- idle timeout.

---

## 9. Resource behavior

Resource efficiency is a product feature, not a hidden implementation detail.

### Always allowed while the app is open

- Tauri core;
- one system WebView;
- lightweight Svelte UI state.

### Conditional

- CodeMirror: only when a text file/diff editor is visible.
- Markdown renderer: only when Markdown preview is visible.
- Codex App Server: only when Codex/history/model/auth functionality is needed; eligible for idle shutdown.
- Git: short-lived commands on meaningful events.
- Terminal/PTY: only while terminal is explicitly open.
- Future LSP: only after explicit "Smart/Intelligence" intent, with an idle shutdown timer.

### Target performance behavior

These are engineering targets, not hardware-independent guarantees:

- no continuous repo-wide polling;
- no recursive watcher in v1;
- no always-on Node.js runtime;
- no always-on LSP;
- no background Git status loop;
- idle CPU should settle close to zero after UI activity stops;
- app-owned memory should remain small enough that leaving the app open all day is reasonable;
- current-turn logs and giant diffs must be bounded/virtualized.

---

## 10. v1 scope

### Must ship

- Tauri desktop app.
- Svelte/TypeScript UI.
- Open local project.
- Lazy file tree.
- Read-only and manual edit file modes using CodeMirror 6.
- File tabs with one active editor instance.
- Markdown Preview/Edit/Split.
- Codex App Server lifecycle and stdio JSONL transport.
- Codex initialize handshake.
- ChatGPT login flow and account state when needed.
- Model discovery.
- Create/resume thread.
- Start/interrupt turn.
- Stream agent events.
- Command/file-change visibility.
- Approval UI and responses.
- Live changed-files list.
- Live aggregate turn diff when provided by App Server.
- Final Git status/diff for Git projects.
- Runs/thread history for current project.
- Robust error and disconnected states.
- Dark mode as polished default; light/system appearance supported if inexpensive.
- Build/test scripts.

### Explicitly out of scope for v1

- VS Code extension compatibility.
- Extension marketplace.
- Debugger/breakpoints.
- Full terminal multiplexing.
- Always-on semantic indexing.
- Always-on language servers.
- Complete IntelliSense parity.
- Refactor/rename across arbitrary languages.
- Remote SSH/dev containers.
- GitHub PR UI.
- Source-control graph.
- Multi-agent orchestration.
- Automatic worktree management.
- Cloud sync.
- Telemetry/analytics.
- Custom backend/server.
- User accounts for this app.
- Database.

---

## 11. Success criteria

A v1 is successful when a user can:

1. launch the app;
2. open an existing repository;
3. authenticate Codex if required;
4. send "add X feature";
5. watch real Codex activity without opening a terminal;
6. approve requested actions;
7. see changed files/diff while Codex works;
8. see whether commands/tests passed;
9. receive a clear completed/failed state;
10. inspect source files and Markdown;
11. make a small manual edit and save it;
12. close/reopen the app and resume the Codex thread;
13. leave the app idle without unnecessary background work.

The product must feel **transparent, calm, fast, and deliberate** rather than feature-dense.
