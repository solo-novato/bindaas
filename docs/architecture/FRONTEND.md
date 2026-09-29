# Frontend structure

The UI is Svelte 5 (runes) + TypeScript, served by Vite and hosted in the Tauri WebView. It talks to the Rust core only through the typed bindings in `src/lib/api.ts`.

## Where things live

| Area              | Files                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App coordinator   | `src/App.svelte` — shared conversation and project state, agent event handling, sending/steering, workspace restore, keyboard shortcuts. Renders the layout from the components below.      |
| Shell             | `components/TopBar.svelte`, `ExplorerPane.svelte`, `InspectorPane.svelte`, `PaneDivider.svelte`                                                                                             |
| Conversation      | `components/TaskHeader.svelte`, `WelcomeScreen.svelte`, `Onboarding.svelte`, `Timeline.svelte`, `Markdown.svelte`, `ApprovalCard.svelte`, `QuestionCard.svelte`                             |
| Composer          | `components/ComposerControls.svelte`, `QueueCard.svelte`, `MentionMenu.svelte`, `AttachmentPreview.svelte`                                                                                  |
| Workspaces        | `components/FileWorkspace.svelte` (+ `CodeEditor.svelte`), `ReviewWorkspace.svelte` (+ `DiffView.svelte`), `RunsWorkspace.svelte`, `SettingsView.svelte`                                    |
| Overlays          | `components/CommandMenu.svelte` (⌘K), `ProjectSwitcher.svelte`, `SessionPanel.svelte`, `TreeMenu.svelte`, `Toasts.svelte`                                                                   |
| App logic modules | `lib/app/launchEntries.ts` (⌘K entries, pure), `lib/app/fileSearch.svelte.ts` (project search, @ mentions), `lib/app/explorerActions.ts` (create/rename/trash)                              |
| Shared state      | `lib/editor.svelte.ts` (open files and dirty buffers), `lib/explorer.svelte.ts` (tree selection, inline edits, per-folder refresh), `lib/dialog.svelte.ts` (confirmations)                  |
| Pure helpers      | `lib/diff.ts`, `lib/timeline.ts`, `lib/runs.ts`, `lib/launcher.ts`, `lib/markdown.ts`, `lib/reading.ts`, `lib/session.ts`, `lib/workspace.ts`                                               |
| Motion            | `lib/motion.ts` — every JS-driven animation goes through it so Power saving and Reduce Motion turn them off                                                                                 |
| Styles            | `src/app.css` imports `src/styles/*.css` in cascade order: tokens → base → shell → explorer → chat → composer → decisions → review → files → history → settings → dialogs → accent → motion |

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
