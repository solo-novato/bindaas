# Changelog

All notable changes to Bindaas are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - Unreleased candidate

### Added

- Multi-step task queues: line up up to 20 follow-ups per conversation, reorder or edit them inline, pause/resume, and send the first step immediately. Every step retains its mode, model, effort, attachments, and context, and background conversations advance independently.
- Queue recovery stops after a failed, interrupted, or disconnected task or an unconfirmed send. Failed entries stay in place for explicit retry, and replayed completion events cannot dispatch the same step twice.
- Unfinished queue edits survive conversation and view switches. Queued work keeps its project window open when choosing another project, and closing or quitting warns before discarding session-only queues.
- Explicit file context: choose a lightweight disk reference or a frozen snapshot of the current editor, including unsaved text. Preview/copy the exact payload, refresh full-file snapshots deliberately, and add exact selected ranges. Bounded captures stay frozen through edits, queued sends, and send failures without reading or saving files in the background.
- On-demand file-conflict recovery: compare the local buffer and a file-scoped disk snapshot, refresh explicitly, copy the full local text, and confirm saving the local version against the reviewed fingerprint. Preview rendering is bounded; incomplete or unavailable disk previews cannot authorize replacement.

### Fixed

- Combined workflows preserve independent new-conversation drafts when another conversation sends or drains its queue. Unsent drafts and pending delivery acknowledgements keep their project window, and closing warns before discarding them.
- Message size checks include all context labels and delimiters before enqueue or send, keeping oversized drafts intact for correction. Selection capture after an in-place rename uses the new file path while retaining the highlighted text and undo history.
- A failed preference write after Claude accepts a message now reports a warning without making that accepted queued step retryable.
- Quick-open search clears results from the previous query immediately, so pressing Enter while a new search is pending cannot open a stale match. Unavailable project search stops its loading indicator, and selecting a result cancels any remaining search.
- Selection context keeps its original file and exact range, including selections ending at the next line's start; disjoint selections on one line no longer replace each other.
- File creation, rename, and Trash keep their originating project and reject stale operations after a project change. Pending mutations reserve affected files against editing, saving, closing, or competing actions, preserve editor state through rename, and release controls after failures. Late results cannot reset another project's explorer or newer inline edits.
- Failed, stale, binary, oversized, or mismatched reloads preserve unsaved file buffers. New edits typed while a save or reload is awaiting acknowledgement remain protected, including Save from a closing tab.
- Repeated file saves are serialized per tab, comparison reads stay with their file, and late replies or errors cannot replace another tab or a new project’s state.
- Comparing a file preserves the existing editor’s undo history and returns keyboard focus when closed. Editing pauses during a project switch so late typing cannot be discarded after the unsaved-file check.

### Security

- Update the locked transitive `devalue` dependency to 5.9.3 to address its published security advisories.
- Update the development-only transitive `source-map-js` dependency to 1.2.2 to address its indexed source-map denial-of-service advisory. Production dependencies are unchanged.

## [0.2.0] - 2026-09-29

### Added

- Claude Code works on its own, without the Codex CLI. First-run setup finds either agent (one is enough), new conversations start with the agent you used last, and file search (`@`, `⌘P`) falls back to the files git knows when Codex isn't installed.
- Multiple projects at once, one window per project: `⌘⇧N`, **New window** in the project menu, or `⌘↵` on a project. Every window runs its own tasks on one shared Codex process, open windows come back at launch, and the dock badge counts all windows.

### Changed

- Choosing another project while tasks are running opens it in a new window instead of asking you to wait.
- Without the Codex CLI, History no longer warns about it and new conversations no longer default to it.
- Closing one of several windows stops only that project's tasks (after asking); quitting asks each window about its own tasks and unsaved files.

## [0.1.0] - 2026-09-28

### Added

- First public release as **Bindaas** (previously developed as "Codex Workbench").
- First-run setup: finds the Codex CLI, checks its version and sign-in, and asks how much access new conversations get.
- **New conversations** setting: Standard (workspace access, ask when needed) by default, or Full access for every new chat.
- Explorer file actions: New file/folder, Rename, Move to Trash, Copy path, Reveal in Finder, Open in default app, Add to chat.
- `@` file mentions and project-wide `⌘P` search via Codex's on-demand file search.
- Retry for failed tasks and Rewrite for your latest message.
- Questions and approvals dock above the composer; in-app notifications and a dock badge for background tasks.
- Expressive motion with a Power saving mode (`⌘⇧M`).
- Settings → About: version, license, third-party notices, Copy diagnostics.

### Changed

- Opening an existing conversation no longer changes its permissions.
- Agent processes receive your login shell's environment, so Codex installed with npm, nvm, Volta, bun, or Homebrew works when Bindaas is opened from Finder.
- Codex versions older than 0.154.0 are refused with an update message; unsupported requests explain that Codex needs updating.

### Security

- "Open in default app" refuses apps, scripts, installers, link files, and executables.

[Unreleased]: https://github.com/solo-novato/bindaas/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/solo-novato/bindaas/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/solo-novato/bindaas/releases/tag/v0.1.0
[0.2.1]: https://github.com/solo-novato/bindaas/compare/v0.2.0...dot/safe-file-conflict-recovery
