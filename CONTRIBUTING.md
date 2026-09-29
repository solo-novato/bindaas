# Contributing to Bindaas

Thanks for helping! Bindaas is a small Tauri 2 app: a Svelte 5 + TypeScript frontend and a Rust core that drives the Codex CLI and/or Claude Code over their local protocols. This guide gets you from clone to pull request.

## Prerequisites

- Apple silicon Mac, macOS 13.1+ (the app and CI target `aarch64-apple-darwin`).
- Xcode Command Line Tools: `xcode-select --install`
- Node.js 22.12+ or 24+
- Rust stable via [rustup](https://rustup.rs), with `rustfmt` and `clippy` (`rustup component add rustfmt clippy`)
- Optional, for trying real tasks: the [Codex CLI](https://github.com/openai/codex) 0.154.0+ or [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 2.1.274+, signed in. Tests never need either.

## Get running

```sh
npm ci
npm run desktop        # Tauri dev build with hot reload
```

`npm run dev` serves only the web UI at http://127.0.0.1:1420. Without the native app it shows a "desktop services unavailable" state — the UI tests use a mocked bridge instead (see below).

Build a local release app and DMG:

```sh
npm run dist:mac
open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Bindaas.app
```

## Project map

| Path                             | What lives there                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.svelte`, `src/lib/app/` | App shell and feature state                                                                                                                                                 |
| `src/lib/components/`            | UI components (timeline, composer pieces, review, explorer, dialogs…)                                                                                                       |
| `src/lib/*.ts`                   | Pure helpers: diff parsing, timeline grouping, launcher ranking, motion, API bindings                                                                                       |
| `src/styles/`                    | Design tokens and styles, split by area (`app.css` imports them)                                                                                                            |
| `src-tauri/src/`                 | Rust core: `files.rs` (contained file access), `git.rs`, `settings.rs`, `shell_env.rs`, `codex/` (App Server client), `claude/`, `commands.rs` / `agents.rs` (IPC commands) |
| `src-tauri/tests/`               | Rust integration tests against fake app servers in `tests/fixtures/`                                                                                                        |
| `tests/ui/`                      | Playwright journeys with a mocked Tauri bridge (`fixtures.ts`)                                                                                                              |
| `tests/unit/`                    | Vitest unit tests                                                                                                                                                           |
| `docs/architecture/`             | Architecture notes; `docs/history/` has the original specs and build logs                                                                                                   |

## Checks (the same ones CI runs)

```sh
npm run check                                   # svelte-check / TypeScript
npm run lint                                    # Prettier
npm test                                        # Vitest
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml # needs Node (fake app servers)
npm run test:ui                                 # Playwright, Chromium
PLAYWRIGHT_BROWSER=webkit npm run test:ui       # Playwright, WebKit (what macOS uses)
```

First time only: `npx playwright install chromium webkit`.

**Accessibility audit.** The UI suite includes an axe-core audit that runs when `WORKBENCH_AXE_PATH` points at axe:

```sh
npm install --prefix /tmp/bindaas-axe --no-package-lock axe-core
WORKBENCH_AXE_PATH=/tmp/bindaas-axe/node_modules/axe-core/axe.min.js npm run test:ui
```

**Motion.** Animations must not run while the app is idle, and Power saving (`data-motion="saving"`) must turn every animation off; both are enforced by tests in `tests/ui/settings.spec.ts`. Use the helpers in `src/lib/motion.ts` for JS-driven motion.

**Refactoring styles or markup.** `npm run styles:snapshot` records the computed style of every element across the main screens (both themes) to `test-results/style-snapshot.json`. Copy it aside, make your change, run it again, then `node scripts/style-diff.mjs before.json test-results/style-snapshot.json` — zero differences means nothing visible changed.

**README images.** `npm run screenshots` regenerates `docs/images/` from the mocked fixtures. Normal test runs write screenshots only to `test-results/` (git-ignored).

**Dependencies.** After adding or updating a dependency, run `npm run notices` and commit the regenerated `THIRD_PARTY_NOTICES.md`; CI fails if it is stale. Prefer small, well-maintained dependencies with permissive licenses.

## How we build things

The order of priorities, when they conflict:

1. Correctness and data safety — never lose edits, never overwrite files, dirty buffers always win.
2. Honest observability of real agent activity — no invented progress.
3. Low idle CPU and memory — no polling, no recursive watchers, no background indexing; agent processes sleep when idle.
4. A responsive, calm UI.
5. Simple implementations.
6. Feature breadth.

Also:

- Privileged operations are narrow Rust commands that validate project containment (`files::contained`). Never expose a generic shell or filesystem to the frontend.
- Don't change an existing conversation's permissions implicitly.
- No telemetry and no network calls from the app itself.
- Keep UI accessible: semantic controls, visible focus, keyboard paths, and contrast that passes the axe audit in both themes.
- Match the surrounding code style; comments explain _why_, not what.

## Pull requests

- Keep PRs focused. For larger changes, open an issue first to agree on the approach.
- Add or update tests for behavior changes — a Playwright journey for UI flows, Rust tests for core logic.
- Update docs (README, `docs/`) when user-facing behavior changes, and add a line to `CHANGELOG.md` under **Unreleased**.
- CI must pass. Screenshots or a short screen recording help reviewers for UI changes.

By contributing, you agree that your contributions are licensed under the project's [MIT License](LICENSE).

## Releasing (maintainers)

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; update `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The **Release** workflow builds the Apple silicon DMG, attaches it with its SHA-256 checksum to a draft GitHub release, and you publish it after a quick smoke test.
3. Releases are ad-hoc signed but not notarized; the install guide explains the one-time Gatekeeper step.
