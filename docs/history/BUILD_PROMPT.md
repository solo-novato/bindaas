# One-Shot Build Prompt for Codex

Copy/paste the prompt below into Codex from the repository that contains this handoff pack.

---

Build the entire v1 of this project now.

Before writing code, read `AGENTS.md` and every referenced document completely. Treat the product, architecture, LLD, UX, and guardrail documents as implementation-authoritative.

The goal is a **real, runnable Tauri 2 desktop application**, not a UI prototype. Implement the complete core workflow end to end:

- open a local project;
- lazy file tree;
- CodeMirror 6 read-only viewer and explicit manual edit mode;
- logical file tabs using one active editor instance;
- Markdown Edit/Preview/Split;
- system Git integration without background polling;
- discover and spawn installed `codex app-server`;
- stdio JSONL JSON-RPC client;
- correct `initialize` → `initialized` handshake;
- ChatGPT auth/setup states required to use Codex;
- model discovery via `model/list`;
- start/resume/list Codex threads;
- start and interrupt turns;
- stream agent messages and observable activity;
- render command execution and bounded command output;
- render file changes;
- handle server-initiated approvals correctly;
- show live aggregate turn diff when available;
- refresh final Git state/diff at turn completion;
- runs/history for the current project;
- safe file-saving conflict detection;
- Codex idle shutdown and restart/resume;
- polished loading, empty, failure, disconnected, and no-Codex-installed states.

Do not use Electron, Monaco, a Node backend, a database, recursive repo watchers, Git polling, or an always-on language server.

Keep the app highly transparent: the user should be able to see what Codex is actually doing, which files are changing, which commands are running, what failed, and what is waiting for approval. Do not fabricate or expose hidden chain-of-thought.

Use current official Codex App Server documentation if a wire-level detail in the handoff has changed:
https://learn.chatgpt.com/docs/app-server

You may generate the App Server schemas from the installed Codex CLI during development if useful.

Work autonomously. Do not stop after scaffolding and do not ask me to approve normal implementation phases. When a minor detail is unspecified, choose the simplest safe implementation consistent with the docs and continue.

Create a deterministic fake App Server fixture for integration tests so tests do not require my ChatGPT account.

When implementation is complete:

1. format the code;
2. run frontend typecheck/lint/tests as configured;
3. run Rust tests/checks;
4. run integration tests;
5. run the Tauri build/check steps available in this environment;
6. fix failures in the core flow;
7. give me a concise final summary with exact commands to run the app and any real environment limitation.

Do not leave placeholders in the core Codex integration, approvals, file IO, diff, or task timeline.
