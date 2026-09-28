# Open-source readiness checklist

Status as of September 28, 2026. Decisions made: **Bindaas** (name), **MIT** (license, "The Bindaas contributors"), **macOS on Apple silicon only**, **no notarization** for now, repository **[solo-novato/bindaas](https://github.com/solo-novato/bindaas)**.

## Done

- [x] **Name and identity.** Renamed to Bindaas, with bundle ID `dev.bindaas.desktop`. Existing settings and attachments migrate from the old ID on first launch. A non-affiliation disclaimer is in the README, the app's About section, and the bundle description.
- [x] **License and notices.** MIT `LICENSE`. `npm run notices` generates `THIRD_PARTY_NOTICES.md` (npm and Rust components shipped in the app, including OFL fonts and MPL crates), which is bundled into the app and checked in CI.
- [x] **Personal data scrubbed.** No personal paths, profile names, or process samples remain. The test fixture's real URL was replaced.
- [x] **Repository hygiene.**
  - Removed `artifacts/` (100 MB of binaries), `dist/`, `test-results/`, `.DS_Store` files, redesign screenshots and GIFs (docs went from 35 MB to about 1 MB), and generated schemas.
  - `.gitignore` extended.
  - Tests write screenshots only to `test-results/`; README images come from `npm run screenshots`.
- [x] **Safer defaults.**
  - New conversations start with Standard access; "Full access for all new conversations" is a setting.
  - Existing conversations are never changed implicitly.
  - "Open in default app" refuses apps, scripts, installers, link files, and executables.
- [x] **Works from Finder.** Agent processes get the login shell's environment. Codex and Claude are found via the shell `PATH` plus Homebrew, npm, nvm, Volta, bun, and `~/.local/bin`.
- [x] **Codex compatibility.**
  - Minimum version 0.154.0, checked at connect (from the app server's user agent) and during setup.
  - Unknown methods explain that Codex needs updating.
- [x] **Packaging.** Apple silicon DMG (`npm run dist:mac`), ad-hoc signed, minimum macOS 13.1, with bundle metadata.
- [x] **First-run setup.** Finds Codex, shows install commands, handles sign-in, chooses access, opens a project. Can be re-run from Settings.
- [x] **Docs.** User-facing `README.md`, `docs/INSTALL.md` (including the Gatekeeper step), `CHANGELOG.md`.
- [x] **Diagnostics.** Settings → About → Copy diagnostics (no file contents or conversations).
- [x] **Contributors.**
  - `CONTRIBUTING.md`, `AGENTS.md` (rewritten), `SECURITY.md`, `CODE_OF_CONDUCT.md`.
  - Issue and PR templates, Dependabot.
  - CI: typecheck, lint, unit, rustfmt, clippy `-D warnings`, Rust tests, notices check, `npm audit`, and Playwright in Chromium and WebKit with the axe audit.
  - A release workflow that builds a draft GitHub release with the DMG and checksums.
- [x] **Code structure.**
  - `app.css` split into 14 area stylesheets.
  - `App.svelte` down from about 4,350 to about 3,280 lines via 10 components and 3 logic modules.
  - The 5,800-line UI spec split into 8 area specs with shared fixtures.
  - Style refactors are verifiable with `npm run styles:snapshot`.

## Before the first public release

- [x] GitHub owner `solo-novato`; all repository links point to `solo-novato/bindaas`.
- [x] Repository created from this folder only (not the parent folder, which holds personal data). Commits use the GitHub noreply address.
- [x] **Private vulnerability reporting** enabled (`SECURITY.md` relies on it).
- [ ] Push, confirm CI is green on GitHub's macOS runners, then tag `v0.1.0` and publish the draft release after a smoke test.
- [ ] Smoke-test the release DMG on a clean macOS user account with an npm-installed Codex: install, run the Gatekeeper step, go through setup, and run one task.

## Later

- [ ] Notarize releases (Apple Developer account) to remove the Gatekeeper step.
- [ ] Move the conversation state machine out of `App.svelte` into a store (see `docs/architecture/FRONTEND.md`).
- [ ] Auto-update (opt-in, since it adds a network request).
- [ ] Homebrew cask, Intel/universal builds, Windows/Linux.
- [ ] A manual VoiceOver pass.
