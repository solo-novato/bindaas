# Installing Bindaas

Bindaas runs on **Apple silicon Macs** (M1 or later) with **macOS 13.1 or later**.

## 1. Install the Codex CLI

Bindaas drives the Codex CLI you install yourself (version **0.154.0 or later**). Pick one:

```sh
npm install -g @openai/codex    # needs Node.js 18+
brew install codex              # Homebrew
```

Then sign in once — either inside Bindaas during setup, or in a terminal:

```sh
codex login
```

Optional: install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (2.1.274 or later) and sign in with `claude auth login` to use Claude alongside Codex (enable it in **Settings → Integrations**).

## 2. Install the app

1. Download **`Bindaas_<version>_aarch64.dmg`** from the [latest release](https://github.com/solo-novato/bindaas/releases/latest). Each release lists a SHA-256 checksum you can verify with `shasum -a 256 Bindaas_*.dmg`.
2. Open the DMG and drag **Bindaas** into **Applications**.

### First launch on an un-notarized app

Release builds are signed ad hoc but not notarized by Apple (that needs a paid Apple Developer account). macOS therefore blocks the first launch with _"Bindaas is damaged and can't be opened"_ or _"Apple could not verify…"_. This is expected. To allow it:

```sh
xattr -dr com.apple.quarantine /Applications/Bindaas.app
```

or open Bindaas once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

You only need to do this once per downloaded version.

## 3. First-run setup

Bindaas walks you through:

1. **Finding Codex.** It searches your shell's `PATH` plus Homebrew, npm (including nvm, Volta, and bun), and `~/.local/bin`. If yours lives elsewhere, choose it with **Choose Codex executable…**.
2. **Signing in.** Use **Sign in with ChatGPT** (opens your browser) or run `codex login`, then click **I've signed in**.
3. **Default access for new conversations.** _Standard_ (recommended) lets Codex work inside the project and ask for more; _Full access_ never asks. Change it later in **Settings → New conversations**.

Open a project folder to finish. You can re-run setup from **Settings → About → Run setup again**.

## Updating

Download the newer DMG and replace the app in Applications (then repeat the `xattr` step). Your settings are kept.

## Build from source instead

Building locally avoids the quarantine step entirely.

Prerequisites: Xcode Command Line Tools (`xcode-select --install`), [Node.js](https://nodejs.org) 22.12+ (or 24+), and [Rust](https://rustup.rs) (stable).

```sh
git clone https://github.com/solo-novato/bindaas.git
cd bindaas
npm ci
npm run dist:mac
open src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Bindaas.app
```

The DMG is written to `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`.

## Uninstall

Delete Bindaas from Applications. To remove its preferences and saved attachments too:

```sh
rm -rf ~/Library/Application\ Support/dev.bindaas.desktop ~/Library/Caches/dev.bindaas.desktop ~/Library/WebKit/dev.bindaas.desktop
```

Codex and Claude Code keep their own conversation history in their usual locations.
