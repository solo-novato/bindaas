# Codex Workbench — UX Specification

> Companion to `PRODUCT.md`. When implementation choices conflict, preserve the product principles: agent-first, maximum observable visibility, minimal background work.

## 1. Visual character

The UI should feel like a premium native developer utility:

- dark, calm, low-chrome default;
- high information density without looking busy;
- clear status hierarchy;
- subtle borders rather than large cards everywhere;
- monospace only where code/paths/commands benefit;
- ordinary UI text uses a system sans-serif stack;
- animation only for state transitions or active work;
- no decorative looping animation.

Desktop target first: macOS, approximately 1440px+ wide, while keeping the layout functional down to ~1000px.

---

## 2. Global shell

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ ● ● ●  Project        branch        Chat Files Changes Runs Settings       │
│                                                  Ready / Working   New Task │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Left side of title bar

- Project display name.
- Truncated absolute path on hover/secondary line.
- Git branch when available.
- Clicking project opens recent-project switcher.

### Center nav

Tabs:

- Chat
- Files
- Changes
- Runs
- Settings

Keyboard:

- `⌘1` Chat
- `⌘2` Files
- `⌘3` Changes
- `⌘4` Runs

### Right side

Agent state indicator:

- green: Ready
- blue pulse: Working
- amber: Waiting for approval
- red: Failed/disconnected
- gray: Sleeping/not started

Label state in text; do not rely on color alone.

`New Task` creates a fresh thread only after the user confirms/sends the first prompt. Opening the composer itself should not spawn Codex.

The title bar also provides a compact Tasks switcher, with the count of turns observed working in this project. Opening it explicitly loads Codex history into the searchable launcher. Background tasks needing input, reporting a failed follow-up, or having a failed/disconnected turn expose a direct attention action. Task lists prioritize attention entries and remain bounded; they do not grow a horizontal card strip above the conversation.

---

## 3. Three-pane working layout

Default widths:

- project tree: 220–260 px;
- main: flexible, minimum 480 px;
- inspector: 380–520 px.

Both side panes are collapsible.

Persist pane widths per machine, not per project.

Pane dividers are focusable separators that announce their current width. Left/right arrows move the divider by 10 px (Shift: 40 px), Home/End select the available limits, and Enter or double-click restores the default width. Pointer dragging uses pointer capture and commits the resulting size when released. Temporarily fit the side panes to the window to preserve at least 480 px for the main area at supported window sizes; retain preferred widths when the window grows again. Closing a pane returns focus to its reveal control; opening the inspector puts focus inside it.

### Responsive rules

Below ~1150 px:

- inspector becomes an overlay/drawer;
- project tree remains collapsible;
- never compress the main task timeline below readable width.

---

## 4. Project tree

### Row content

```text
▾ src
  ▸ api
  ▸ auth
    session.ts
    user.ts
▸ tests
package.json
README.md
```

### Behavior

- directory expand triggers a filesystem request for that directory only;
- no spinner unless request exceeds ~120 ms;
- while loading slowly, show a lightweight inline skeleton;
- single click file opens it;
- `⌘P` opens a filename quick-open based on currently discovered files in v1;
- do not secretly crawl the entire project to power quick-open;
- an explicit `Search project` can run an on-demand `rg --files`/search process in a later phase.

### Hidden/generated directories

Hidden by default when detected:

- `.git`
- `node_modules`
- `.next`
- `dist`
- `build`
- `target`
- `vendor`
- `.venv`
- `venv`
- `coverage`
- `.turbo`
- `.cache`

Show a subtle "generated folders hidden" footer action.

---

## 5. Chat/task timeline

### User prompt

Render user prompts as normal chat entries, but the active prompt also anchors the task header.

### Event groups

Use these visual event categories:

| Category      | Icon/state      | Example                             |
| ------------- | --------------- | ----------------------------------- |
| Agent message | Codex icon      | "I'll inspect the auth flow first." |
| Read/search   | document/search | "Read 3 files"                      |
| Command       | terminal        | `pnpm test`                         |
| File change   | file-diff       | "Modified 4 files"                  |
| Approval      | shield          | "Network access requested"          |
| Warning       | warning         | command failed / partial state      |
| Completion    | check           | turn completed                      |
| Error         | x               | turn failed                         |

### Expansion

Each event has two levels:

**Collapsed**

```text
✓ Ran pnpm test                    exit 0 · 8.2s
```

**Expanded**

```text
Command
pnpm test

cwd
/Users/me/project

Output
PASS tests/auth.test.ts
...
```

Never render thousands of output lines into the DOM by default.

### Streaming

Agent text may stream.

For very frequent delta events:

- update displayed text in batches rather than one DOM mutation per token/chunk;
- keep scrolling stable if the user has scrolled upward;
- auto-follow only if the viewport was already near the bottom.

Show a small `Jump to latest` pill when new events arrive off-screen.

---

## 6. Live changes inspector

Top block:

```text
Changes (4)                                      ● Live

M src/middleware/rateLimit.ts              +120  -0
M src/api/index.ts                           +8  -2
A tests/rateLimit.test.ts                   +86  -0
M README.md                                  +12  -1
```

The list must update during an active turn when trustworthy diff/file events arrive.

Click a file to switch the lower inspector to that file's diff.

Empty inspector states distinguish a repository snapshot with no changes, unavailable Git, a task still working, no selected task, and a task with no reported changes in loaded history. Do not describe missing task events as proof of a clean working tree. Repository refresh is explicit. A reported completed plan provides a direct route back to the plan card, preserving Codex mode and starting no turn.

### Diff panel

Header:

```text
src/middleware/rateLimit.ts        +120 -0
[Unified] [Split] [File]
```

Rules:

- use virtualization or line-windowing for large diffs;
- do not render an entire giant diff into hidden tabs;
- syntax color is optional for the small inspector diff;
- full split view may lazy-load CodeMirror MergeView.

### Ask about a diff

Text selection in diff exposes:

`Ask Codex`

The composer receives a visible context chip such as:

`rateLimit.ts · changed lines 32–51`

The user can remove the chip before sending.

---

## 7. Composer

### Proposed plans and implementation

Codex `plan` items have a distinct Proposed plan card with Markdown, streaming state, copy/quote actions, and a direct Read plan action after completion. The final `item/completed` text replaces the streamed draft. Do not infer a proposed plan from headings, an ordinary assistant message, or the selected mode.

Only the latest complete, untruncated plan in the selected completed turn offers Revise plan and Prepare implementation. These explicit actions ask Codex to change to Plan or Code respectively, wait for its confirmed settings, then add the plan as inspectable context and prepare a reply. Preserve existing draft text. Never send automatically. A failed settings change leaves the draft intact. Merely viewing a plan or receiving completion does not change mode.

`turn/plan/updated` describes reported task progress, not a proposed plan or approval request. Render it as a separate bounded step list with the exact reported statuses. After the turn ends, label it as last reported progress; do not mark pending steps complete. This event-only progress is not invented when history lacks it.

Persistent composer at the bottom of the main work area, aligned with the conversation rather than spanning the explorer and inspector. Keep one mounted textarea through Chat/Files/Changes navigation. Long drafts and pending questions share bounded space; text can scroll while send/stop and question submission remain reachable. Task metadata and the full original prompt are available through the Task details disclosure.

```text
┌─────────────────────────────────────────────────────────────┐
│ Ask Codex anything…                                        │
│                                                             │
│ +  @ Context                       Model ▾  Effort ▾    Send │
└─────────────────────────────────────────────────────────────┘
```

### Context chips

Possible chips:

- file path;
- selected lines;
- changed hunk;
- command output;
- error event.

Do not paste huge context into the visible textarea. Chips expand on hover/click.

Attachments display their name, type, size, and removal action before sending. These are the existing immutable snapshots sent through Codex input; displaying an attachment does not read or index additional project files.

Selecting an attachment opens an on-demand preview of its verified snapshot. Raster images support fitted and actual-size views; UTF-8 text is limited to a 64 KiB prefix with an explicit truncation label. Other formats retain their attachment and explain that preview is unavailable. Loading, retry, image-decode failure, removal, Escape, and keyboard focus return are explicit. Closing the viewer discards its loaded preview; no preview cache or background reads are required.

### Send state

When no turn active:

`Send`

When turn active and steering is supported:

- default button may say `Steer` for a short follow-up;
- `Stop` remains separately visible.

If the product chooses not to expose steering in v1 UI, queue the next prompt until completion instead of silently starting parallel work.

---

## 8. Approval UX

Approvals must interrupt visually but not freeze the rest of the app.

Example:

```text
┌───────────────────────────────────────────────────────┐
│ Permission required                                   │
│                                                       │
│ Codex wants to run:                                   │
│   pnpm install                                        │
│                                                       │
│ Working directory                                     │
│   ~/Projects/lore                                     │
│                                                       │
│ Reason                                                │
│   Install the package requested by the task.          │
│                                                       │
│ [Decline] [Cancel task]        [Allow once] [Session] │
└───────────────────────────────────────────────────────┘
```

Network request example:

```text
Network access
registry.npmjs.org · HTTPS

[Decline] [Allow once] [Allow for session]
```

Use only the actual decisions supplied/allowed by App Server.

---

## 9. File workspace

### Tab bar

Tabs are application UI, not CodeMirror instances.

A dirty tab uses `●`.

Close behavior:

- clean → close immediately;
- dirty → Save / Don't Save / Cancel.

### Read-only default

Opening a file shows read-only mode unless the file is already dirty.

Header:

```text
src/auth/session.ts        View                     Edit
```

### Edit mode

Header:

```text
src/auth/session.ts        Editing ●               Save
```

`⌘S` saves.

No autosave by default.

### Inactive tab memory

For inactive clean tabs retain only:

- path;
- cursor line/column;
- scroll position;
- optional tiny metadata;
- content only if inside a small LRU cache.

Dirty documents must retain their unsaved text.

---

## 10. Markdown

For Markdown:

```text
README.md               Edit | Preview | Split
```

### Preview

- raw HTML disabled;
- external links open through a controlled system-browser action;
- local links resolve inside the project when safe;
- code blocks are highlighted only if doing so does not pull in a large always-on bundle;
- Mermaid and heavy embedded renderers are out of scope v1.

Split mode mounts one editor + one preview, not two editors.

---

## 11. Runs screen

Table/list:

```text
Today

✓ Add rate limiting       2m 41s    4 files   tests ✓
× Fix flaky auth test       51s      1 file    failed
○ Explain cache logic       18s      0 files
```

Selecting a run opens its timeline/history.

Filters:

- All
- Completed
- Failed
- Interrupted

Do not build analytics dashboards in v1.

---

## 12. Failure and disconnected states

### Codex executable not found

Show:

```text
Codex CLI not found

Install/configure Codex, or choose its executable path.

[Choose executable] [Retry]
```

No crash.

### App Server exited unexpectedly

Keep current UI/history visible and show:

`Codex disconnected · Restart`

If no turn is active, restart only after user action or next Codex request.

If a turn was active, clearly mark it `Connection lost` until the resumed thread state is known.

### Git not available / not a repository

The app still works.

Hide branch/Git-specific controls and label final diff source appropriately.

---

## 13. Accessibility and keyboard

Minimum:

- full keyboard focus navigation for primary controls;
- visible focus ring;
- text labels for status icons;
- reduced-motion media query respected;
- semantic buttons;
- no critical hover-only information.

Shortcuts:

- `⌘K` open the workspace launcher
- `⌘⇧L` focus Codex composer
- `⌘⇧F` toggle focus mode without changing panel preferences
- `⌘N` start a new task draft
- `⌘P` quick open discovered file
- `⌘S` save active editable file
- `⌘W` close active file tab
- `⌘F` editor/timeline contextual find
- `Esc` close overlay / cancel selection UI

Avoid stealing common editor shortcuts unnecessarily.

---

## 14. "Maximum visibility" checklist

For every active turn the UI should make it possible to determine, without opening DevTools:

- current turn status;
- current active item if known;
- agent messages;
- command being run;
- command exit/failure;
- files touched;
- current aggregate diff;
- approvals waiting;
- final turn status;
- final agent message;
- test/check commands actually observed;
- App Server disconnect/error.

The UI must **not** claim access to hidden model reasoning.

## 15. Dedicated review workspace (September 21 redesign)

Changes opens a focused file rail and a single selected diff; the normal explorer and inspector return with their previous preferences when leaving review. Filter files, move between them, mark an exact patch reviewed, and move to the next unreviewed file. A subsequent edit invalidates its review mark. Missing/truncated patches remain explicitly incomplete.

Hunk navigation pages a bounded diff and prepares Explain or Check regressions follow-ups with inspectable context. Existing drafts are retained and sending remains explicit. Git headers are available under Details. The review header distinguishes Codex task diffs from repository changes and shows observed checks without inferring success.

At widths up to 1150px, the inspector is a closed-by-default, explicitly opened drawer. Escape closes it and restores focus to its toggle; the wider desktop panel preference is preserved.
