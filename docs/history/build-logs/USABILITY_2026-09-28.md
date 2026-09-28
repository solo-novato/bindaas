# Usability sweep — September 28

Requested by the user:

1. Create files from the sidebar.
2. Questions docked just above the composer.

Chosen from my suggestions: explorer actions, `@` mentions with project search, retry and rewrite, and a dock badge.

## Explorer file actions

- **Buttons and menu:**
  - New file and New folder buttons in the explorer header. They target the selected folder, or the folder of the selected file.
  - A right-click menu on entries and on empty space. It opens from the keyboard with Shift+F10 or the menu key, and supports arrow keys, Home/End, and Esc with focus return.
- **Inline name field:** Enter confirms; Esc or blur cancels. Errors appear inline.
  - Nested names create intermediate folders and reveal them.
  - New files open in edit mode.
- **Rust** (`files.rs`):
  - `create` uses `create_new` / `create_dir` and never overwrites.
  - `rename` uses macOS `renamex_np(RENAME_EXCL)`, so it never replaces an existing entry; case-only renames are handled.
  - `trash` moves to the macOS Trash via `NSFileManager`, with no Finder automation prompt.
  - Every path is contained in the project: no `..`, no absolute paths, no symlink escapes. The project root can't be renamed or trashed.
- **Frontend safety:**
  - Unsaved edits at or under a path block rename and trash.
  - Trash confirms first.
  - Clean tabs follow a rename.
- **Refresh:** only the touched folder reloads, through per-folder revisions, instead of remounting the tree.
- **Reveal in Finder** now selects the item (`open -R`).
- **Other actions:** Open in default app, Copy relative/absolute path, and Add to chat (a context chip).

## Decisions above the composer

- Questions and permission approvals now dock between the transcript and the composer, and rise up from the composer.
- The status line reads "Waiting for your answer below".
- Geometry tests assert the new order at 1000, 1280, and 1440 px, along with hit-testing and no overflow.

## `@` mentions and project search

- `codex_fuzzy_file_search` calls Codex `fuzzyFileSearch` on demand, only while a query is typed. It uses one cancellation token, returns at most 50 results, and keeps only paths inside the project.
- **Composer `@` menu:**
  - Matched characters are highlighted; ↑↓ choose, Enter or Tab inserts `@path`, Esc closes.
  - Opened, changed, and seen files are the fallback, with a note when search is unavailable.
- **⌘P / launcher:** typed queries merge project matches into Files, with a "Searching project…" hint. An empty query never searches.

## Recovery

- **↻ Retry** on failed or interrupted tasks resends the original message as a new turn. It never rewrites history.
- **Rewrite** on your latest message (Codex only, idle only):
  1. confirms;
  2. calls `thread/revert` (the replacement for the deprecated `thread/rollback`);
  3. reloads the conversation;
  4. restores the message into the composer.
     Files on disk are not reverted, and the confirmation says so. Nothing is sent. (The name "Rewrite" avoids an accessible-name clash with Send.)

## Dock badge

The macOS dock badge shows the number of background conversations needing attention, plus one if the current conversation has a pending decision. It updates only when that count changes. Permission: `core:window:allow-set-badge-count`.

## Verification

- **Rust:** file tests for create, nested create, symlink escape, rename exclusivity, and trash refusals.
- **Playwright:** seven new journeys. The explorer-focus and geometry expectations were updated for the new layout.
- **Accessibility:** the axe audit now covers 20 states, adding the explorer menu and mention menu in both themes.
