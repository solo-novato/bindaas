# Changelog

All notable changes to Bindaas are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - Unreleased candidate

### Added

- On-demand file-conflict recovery: compare the local buffer and a file-scoped disk snapshot, refresh explicitly, copy the full local text, and confirm saving the local version against the reviewed fingerprint. Preview rendering is bounded; incomplete or unavailable disk previews cannot authorize replacement.

### Fixed

- Failed, stale, binary, oversized, or mismatched reloads preserve unsaved file buffers. New edits typed while a save or reload is awaiting acknowledgement remain protected, including Save from a closing tab.
- Repeated file saves are serialized per tab, comparison reads stay with their file, and late replies or errors cannot replace another tab or a new project’s state.
- Comparing a file preserves the existing editor’s undo history and returns keyboard focus when closed. Editing pauses during a project switch so late typing cannot be discarded after the unsaved-file check.

- Quick-open search clears results from the previous query immediately, so pressing Enter while a new search is pending cannot open a stale match. Unavailable project search stops its loading indicator, and selecting a result cancels any remaining search.

### Security

- Update the locked transitive `devalue` dependency to 5.9.3 to address its published security advisories.

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
