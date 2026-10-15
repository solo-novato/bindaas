# Frontend structure

The UI is Svelte 5 (runes) + TypeScript, served by Vite and hosted in the Tauri WebView. It talks to the Rust core only through the typed bindings in `src/lib/api.ts`.

## Where things live

| Area              | Files                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App coordinator   | `src/App.svelte` — shared conversation and project state, agent event handling, sending/steering, workspace restore, keyboard shortcuts. Renders the layout from the components below.              |
| Shell             | `components/TopBar.svelte`, `ExplorerPane.svelte`, `InspectorPane.svelte`, `PaneDivider.svelte`                                                                                                     |
| Conversation      | `components/TaskHeader.svelte`, `WelcomeScreen.svelte`, `Onboarding.svelte`, `Timeline.svelte`, `Markdown.svelte`, `ApprovalCard.svelte`, `QuestionCard.svelte`                                     |
| Composer          | `components/ComposerControls.svelte`, `QueueCard.svelte`, `MentionMenu.svelte`, `AttachmentPreview.svelte`                                                                                          |
| Workspaces        | `components/FileWorkspace.svelte` (+ `CodeEditor.svelte`), `ReviewWorkspace.svelte` (+ `DiffView.svelte`), `RunsWorkspace.svelte`, `SettingsView.svelte`                                            |
| Overlays          | `components/CommandMenu.svelte` (⌘K), `ProjectSwitcher.svelte`, `SessionPanel.svelte`, `TreeMenu.svelte`, `Toasts.svelte`                                                                           |
| App logic modules | `lib/app/launchEntries.ts` (⌘K entries, pure), `lib/app/fileSearch.svelte.ts` (project search, @ mentions), `lib/app/explorerActions.ts` (create/rename/trash)                                      |
| Shared state      | `lib/editor.svelte.ts` (open files and dirty buffers), `lib/explorer.svelte.ts` (tree selection, inline edits, per-folder refresh), `lib/dialog.svelte.ts` (confirmations)                          |
| Pure helpers      | `lib/diff.ts`, `lib/timeline.ts`, `lib/runs.ts`, `lib/launcher.ts`, `lib/markdown.ts`, `lib/reading.ts`, `lib/session.ts`, `lib/workspace.ts`                                                       |
| Motion            | `lib/motion.ts` — every JS-driven animation goes through it so Power saving and Reduce Motion turn them off                                                                                         |
| Styles            | `src/app.css` imports `src/styles/*.css` in cascade order: tokens → base → shell → explorer → chat → composer → trail → decisions → review → files → history → settings → dialogs → accent → motion |

## Agent Trail

`AgentTrail.svelte` is a lazily mounted alternate view inside `Timeline.svelte`.
The transcript stays mounted so selection, expanded activity, and reading position
survive switching views. Its selected presentation is remembered with the existing
bounded `ReadingViews` state. The trail does not send model turns or poll.

`lib/trail.ts` projects observed activity into bounded navigation records. Codex
`commandActions` and Claude's whitelisted `toolInput` identify reads and searches;
unknown commands remain commands. Adjacent successful exploration can share a
moment; failed actions, different turns, different parents, and unknown outcomes
do not merge. Notes remain explicitly agent-stated. The connecting line expresses
recorded order, never inferred causation or a claim that actions were sequential.
Unfinished items in an inactive turn have an unavailable outcome.

The live trail retains at most 1,600 compact records while mounted, with original
evidence resolved from the current transcript. “From beginning” uses the existing
native item pagination for the selected turn, 100 items per explicit request,
retaining at most 1,600 records. Source-page cursors allow older evidence to be
read on selection without duplicating full transcripts. Saved history and the
recent live window are separate views: unloaded gaps are never joined into a
false continuous trail. The UI exposes further-page, truncation, and unavailable
source states. Earlier requests remain accessible through History. Native agent
history remains the durable source of truth, including after restart.

## Account usage

`account-usage.svelte.ts` shares the latest account snapshot between `UsageBar.svelte`
and `SessionPanel.svelte`; `UsageAnalysis.svelte` renders the detailed forecast.
`lib/usage.ts` derives pacing and forecasts without network requests. Refreshes follow
agent notifications, connection changes, window focus, and explicit user action.
Disconnected or failed refreshes keep the last observation visible and label it stale.

The Rust `usage_history` module serializes local account-and-plan-specific observations
across windows and imports matching snapshots from the active Codex profile at most
once per day. The importer discloses legacy profile attribution and refuses it when
account evidence is mixed or the header scan is incomplete. Forecasts use the current
period's pace provisionally, then learn weighted daily and weekday rates from valid
historical intervals. Missing days, counter corrections, resets, and saturated or
ambiguous intervals are not treated as measured usage.

## Windows

Each window runs this same app for one project. `App.svelte` listens only for
events addressed to its own window (`{ target: { kind: 'WebviewWindow', label } }`);
the Rust side routes agent events by project. A window asks Rust for the project
chosen for it (`api.initialProject()`); the main window otherwise reopens the last
project. Closing, quitting, and the dock badge go through Rust so they can account
for every window.

## Conventions

- Components receive state as props and report intent through `on…` callbacks; App decides what happens. Snippets are passed where App-owned markup is shared (for example the diff controls used by both the inspector and the review workspace).
- Live agent arrivals may animate; history loads and restores never do (see `Timeline.svelte`), so reading position never moves.
- Styles use the tokens in `styles/tokens.css`; avoid hard-coded colors so both themes and the axe audit keep working.

## Next step

`App.svelte` still owns the conversation state machine (turns, items, approvals, queued follow-ups, background task runs). Moving that into a `lib/app/conversation.svelte.ts` store — with the Tauri event handlers beside it — is the next refactor. Use `npm run styles:snapshot` and the Playwright journeys to confirm nothing visible or behavioral changes.
