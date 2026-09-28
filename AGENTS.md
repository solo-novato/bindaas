# AGENTS.md — guide for coding agents working on Bindaas

Bindaas is a Tauri 2 desktop app (Svelte 5 + TypeScript frontend, Rust core) that drives the user's installed Codex CLI over `codex app-server` (JSON-RPC over stdio) and, optionally, Claude Code. Read `CONTRIBUTING.md` for setup and the project map, and `docs/architecture/` before large changes.

## Priorities (in order)

1. Correctness and data safety: never overwrite files, never lose unsaved edits (dirty buffers win), never widen an existing conversation's permissions implicitly.
2. Honest observability of real agent activity — no invented progress or status.
3. Low idle CPU/RAM: no polling, recursive watchers, background indexing, or always-on processes. Animations must stop when idle.
4. Responsive, accessible UI.
5. Simplicity.
6. Feature breadth.

## Guardrails

- Privileged work goes through narrow Rust commands (`src-tauri/src/commands.rs`, `agents.rs`) that validate paths with `files::contained`. Do not add generic shell or filesystem access for the frontend.
- Use the installed CLIs' protocols as documented; request `model/list` rather than hardcoding models; treat `item/completed` and `turn/completed` as authoritative.
- No telemetry and no network requests from the app itself.
- Keep `THIRD_PARTY_NOTICES.md` current (`npm run notices`) when dependencies change.

## Before you finish

Run the same checks as CI and report their results honestly:

```sh
npm run check && npm run lint && npm test
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:ui && PLAYWRIGHT_BROWSER=webkit npm run test:ui
```

Add a Playwright journey (`tests/ui/*.spec.ts`, fixtures in `tests/ui/fixtures.ts`) for UI behavior changes and Rust tests for core logic. Don't weaken existing assertions to make a change pass; if an expectation must change, say why.
