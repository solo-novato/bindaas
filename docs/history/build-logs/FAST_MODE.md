# Conversation speed controls

Open the top-bar Session status indicator. The Overview tab now contains a **Speed** section with Fast/Standard and two explicit actions:

- **Apply to conversation** changes the selected conversation and its current task, if one was selected.
- **Apply to all N running tasks** snapshots the running tasks in the current Workbench project, including background tasks, and applies the chosen speed to each conversation and exact turn.

Choosing a speed alone sends nothing. Applying it changes only `serviceTier`; model, effort, collaboration mode, approvals, and sandbox permissions remain untouched. Standard sends an explicit null tier. Installed Codex 0.155.1 confirms Fast as `priority` and Standard as `default`; the UI recognizes those values as well as `fast`.

September 24: Standard is now the initial selection in the Speed control, with Fast remaining an explicit choice. The configured Codex profile already has `service_tier = "default"` in `~/.codex-work/config.toml`; no profile write or existing-thread setting change was needed. The selector is an unapplied action choice, separate from Codex's reported conversation tier. The two speed journeys and typecheck/formatting passed after this adjustment.

The September 24 release build and Tauri packaging passed. This update is staged at `standard-default/release/bundle/macos/Codex Workbench.app`; it has not replaced or restarted the installed app.

The Rust command validates the connection generation, project, loaded conversations, duplicate targets, and the exact turn IDs. It bounds a batch to 32 conversations with four requests chains in parallel. It uses `thread/settings/update` for subsequent messages and the installed schema's experimental `turn/settings/update` for a running turn. Workbench already enables experimental capability support for its existing collaboration controls. No interrupt, thread resume, model request, default-config edit, or preference persistence is part of this action.

Codex owns the resulting settings. Running-turn responses must explicitly report `applied`; `targetUnavailable`, unsupported methods, and rejected updates remain visible separately from future-message settings. A completed/replaced turn is not silently replaced with another target. In-flight model requests and child sessions may retain their previous settings. Fast uses additional credits where available.

Validation: the complete 68-test WebKit suite passed, including the existing accessibility checks; seven affected Chromium journeys passed. The 44-test native suite passed, with three new speed-contract tests covering four tasks, partial failure, stale/completed targets, project isolation, and Standard. Fifteen frontend unit tests, typecheck, and formatting passed. An opt-in installed-Codex test verified both Fast and Standard in an ephemeral thread without sending any model turn. Active-turn publication is tested against the generated schema and deterministic fixture; no user's live task was modified during verification.

Packaging is staged separately while the user's existing app is running. The new controls require launching the new native build; a WebView reload cannot add its Rust command to an already-running binary. Do not quit or replace the running app merely to activate this update while tasks are in progress.

The release build passed (17.51 seconds of Rust compilation), and Tauri bundled the app at `fast-mode/release/bundle/macos/Codex Workbench.app`. Its executable matches the newly compiled release binary. The existing `src-tauri/target/release/bundle/macos/Codex Workbench.app` is unchanged. After the old app is safely closed, launch the staged app or install that bundle at the usual location. The staged package has not been opened against the user's live sessions.

Official references: [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Codex App Server](https://learn.chatgpt.com/docs/app-server). Installed 0.155.1 schemas generated into `/private/tmp/workbench-fast-schema` define `TurnSettingsUpdateParams` and its `applied` / `targetUnavailable` response.

Activation: on September 23, the user requested a restart. Workbench exited through its normal quit flow; process absence was verified before replacing the usual app bundle with the staged build. The previous bundle was preserved at `workbench-before-fast-20260923-185500-041469.backup`. The updated app was then launched from the usual path.
