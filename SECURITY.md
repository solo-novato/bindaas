# Security policy

Bindaas runs coding agents that can read and change files and run commands on your Mac, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Include steps to reproduce, the Bindaas version, and your macOS version. We aim to acknowledge reports within a few days and will coordinate a fix and disclosure with you.

## In scope

- Escaping project containment: reading, writing, renaming, or trashing files outside the open project, including through symlinks or path tricks.
- Overwriting files or losing unsaved edits.
- Bindaas changing an agent's permissions or approval policy without an explicit user action.
- Executing code through app features that should not (for example "Open in default app", Markdown links, or previews).
- Rendering untrusted content (agent output, Markdown, file previews) in a way that runs script or reaches the network.
- The IPC surface between the web UI and the Rust core.

## Out of scope

- What an agent does with the permissions you grant it (e.g. Full access). Use Standard access for projects you don't trust.
- Vulnerabilities in the Codex CLI or Claude Code themselves — report those to OpenAI or Anthropic.
- Gatekeeper warnings on un-notarized builds (documented in the install guide).

## Supported versions

Only the latest release receives security fixes.
