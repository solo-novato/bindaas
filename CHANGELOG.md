# Changelog

All notable changes to Bindaas are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/solo-novato/bindaas/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/solo-novato/bindaas/releases/tag/v0.1.0
