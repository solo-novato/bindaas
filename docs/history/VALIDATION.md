# v1 validation — 2026-09-14

Validated on Apple Silicon macOS with Codex CLI 0.154.0, Node 24.2.0, Rust 1.98.1, Tauri 2.11.5, Svelte 5, and Chromium.

| Check                                                       | Result                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                             | Passed; zero errors and warnings                                                                                        |
| `npm run lint`                                              | Passed                                                                                                                  |
| `npm test`                                                  | 9 passed                                                                                                                |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed                                                                                                                  |
| `cargo test --manifest-path src-tauri/Cargo.toml`           | 19 passed: 6 unit, 9 protocol integration, 4 safety                                                                     |
| `npm run test:ui` with installed Chromium override          | 6 passed                                                                                                                |
| `npm run build`                                             | Passed; editor, Markdown, diff, and language code split into lazy chunks                                                |
| Tauri debug and release macOS app bundles                   | Built successfully                                                                                                      |
| `npm audit --json`                                          | Zero vulnerabilities                                                                                                    |
| Installed Codex protocol probe                              | Handshake, 6 discovered models, existing signed-in account, clean shutdown                                              |
| Real Codex task smoke                                       | Exact temporary file content, successful command exit, file-change event, live diff event, terminal completion verified |
| Native launch                                               | Release app opened; native process observed running                                                                     |

The browser suite uses IPC fixtures to exercise the real Svelte components. Rust protocol tests use a separate deterministic process speaking JSONL. The real Codex smoke uses the production Rust transport and the existing account; it creates and deletes a temporary project. These are complementary checks, not a claim that every native interaction was automated.

| Requirement                                            | Implementation and evidence                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open local project; lazy tree; hidden/generated toggle | Rust native picker/project commands, contained one-level listings, browser lazy-startup test                                                                                                      |
| Read-only file viewer and explicit editing             | `FileWorkspace.svelte` and `CodeEditor.svelte`; browser read-only and dirty-edit tests                                                                                                            |
| One editor across logical tabs                         | Clean inactive text released; browser counts one mounted editor and zero after leaving Files                                                                                                      |
| Markdown source/preview/split                          | Dynamic Markdown component; browser verifies preview, split, safe HTML, and local links                                                                                                           |
| Safe file saving/conflicts                             | Fingerprint strings preserve nanosecond precision over JSON; native tests verify atomic saving, permissions, CRLF, stale-fingerprint refusal, binary/size policy, traversal and external symlinks |
| Git without polling                                    | Bounded structured system commands; tests verify porcelain NUL parsing, nested project containment, staged/unstaged separation, non-Git operation                                                 |
| Installed App Server discovery and stdio transport     | Production `Client`; real probe/task and process fixture tests                                                                                                                                    |
| Initialize then initialized                            | Fake process rejects methods before handshake; real probe succeeds                                                                                                                                |
| Auth/setup and dynamic models                          | Account/login and model commands; fixture login completion/idle protection; real account/model probe                                                                                              |
| Thread start/resume/list/history                       | Project-filtered paginated APIs, remembered thread IDs; browser history test and Rust restart/resume test                                                                                         |
| Turn start/interruption/status truth                   | Start/stop commands and authoritative terminal events; fixture and real-task tests                                                                                                                |
| Streamed messages and observable activity              | Normalized items and batched deltas; fixture checks messages, commands, file changes and hidden-reasoning exclusion                                                                               |
| Command output and exit status                         | Bounded previews/retention, expandable output; giant-output and completion tests                                                                                                                  |
| Server-initiated approvals                             | Pending registry, generation validation, exactly-once replies, valid decision checks; command, file, permission, network-detail tests                                                             |
| Live changes and aggregate diff                        | Live event parser, changed files, paged unified/split views; browser, process fixture and real task                                                                                               |
| Final Git refresh and baseline attribution             | Completion refresh and pre-existing dirty paths; browser completion and native Git safety tests                                                                                                   |
| Runs/history                                           | Current-project thread pages, turn status/filter/duration, normalized item pages; browser reconciliation test                                                                                     |
| Sleep/restart/resume                                   | Event-driven deadline protected by active task, approval, request and login; process integration tests                                                                                            |
| Resume an already-running task                         | Running state restored before idle eligibility; test verifies protection and terminal-event/resume race                                                                                           |
| Graceful failure/disconnection                         | Setup and no-Git states, rejected unknown server requests, unknown outcome preserved; disconnect tests                                                                                            |
| App teardown and dirty-close safety                    | Native/window quit route, explicit dirty-tab confirmation, bounded child shutdown; browser dirty-close and native process-reaping tests                                                           |
| Build scripts, docs, profiling checklist               | `package.json`, Cargo manifest, README, implementation notes, performance checklist, generated development schemas                                                                                |

![Workbench task and diff view using the browser acceptance fixture](workbench-task.png)

Environment notes: the build initially ran out of disk space, then completed after space was freed. Rust was installed under `/private/tmp`; README documents this workstation's rebuild commands. The delivered macOS app is a local, unnotarized bundle. A fresh ChatGPT browser login was not performed because the workstation already had a signed-in account; the login protocol is covered by the deterministic fixture.

## Composer update — 2026-09-14

- Frontend: zero check errors/warnings, formatting passed, 9 unit tests passed.
- Rust: 22 tests passed, including 3 new tests for snapshots, file/image bounds, path rejection, and Plan/Code payloads.
- Browser acceptance with mocked Tauri IPC: 10 tests passed, including attachment-only messages, failed-send recovery, pasted screenshots, and queued mode/attachment retention.
- Real Codex via a locally installed Codex CLI: the production attachment store and turn builder supplied a text token and red image in Plan mode. The final authoritative plan contained both; no result file was created. A second turn in Code mode on the same thread wrote exactly `WORKBENCH_FILE_TOKEN red\n`. Temporary files and the owned server were cleaned up.
- Updated release `.app` built successfully and relaunched. The persisted Codex executable setting was verified.

## Workspace and chat update — 2026-09-14

- Frontend check: zero errors/warnings; Prettier and Rust formatting checks passed.
- Unit tests: 10 passed, including versioned workspace storage recovery and project-contained Markdown links.
- Rust tests: 23 passed, including a new real-child fixture test proving WebView reattachment does not issue thread/resume or interrupt an active turn.
- Browser acceptance: 16 covered journeys passed (15-test full run, then a focused six-test reload/reconciliation run including the new active-thread restoration case). New coverage exercises restored project/tabs/tree/view/mode, conversation reload without starting a turn, active-thread selection with pending questions, Markdown tables and safe external/local links, explicit question-card answers, and conversation continuity across follow-ups.
- Browser fixture screenshots reviewed: `workbench-chat.png` and `workbench-questions.png`. These are browser tests with mocked Tauri IPC, not native WebView screenshots.
- Restore intentionally saves navigation metadata, not unsaved editor buffers or composer drafts. Chat initially restores up to six recent turns within the existing 400-item cap; full turn history remains available in Runs.
- Final native release bundle rebuilt and relaunched successfully; the existing Codex executable setting is preserved.

## Codex-owned thread settings (2026-09-14)

Removed model/reasoning preference restoration and collaboration mode from local workspace storage. Workspace persistence retains navigation only. Existing-thread picker changes call `thread/settings/update`; the bridge consumes `thread/settings/updated`. Ordinary continuation requests omit all three setting overrides. Resume no longer forces workspace-write or approval policy over Codex's resumed permissions. Turn headers use their own recorded settings rather than the next-message pickers.

Codex CLI 0.154.0 exposes no mode in `thread/read` / `thread/resume`, emits no settings notification on initial resume, and an empty settings update emits no notification. A metadata-only probe showed a persisted Plan/high turn resuming internally in Default mode. Workbench reads the session-identity-checked rollout path returned by Codex and reapplies Codex's own latest settings via its API. It recognizes both `turn_context` and the newer `thread_settings_applied` event, so settings changed between turns also survive process restarts. No rollout is edited directly and no second settings store is maintained. The read is bounded to the last 16 MiB, 2 MiB per record, and 400 turn settings; unavailable historical metadata stays unknown. Missing current mode requires an explicit picker choice before continuing instead of silently choosing Code. This compatibility fallback depends on Codex's unstable local rollout format and is isolated in `codex/thread_settings.rs`.

Validation: 10 Vitest tests, 30 Rust tests, and 19 browser UI tests passed (59 total). Added coverage for stale local values, models absent from the catalog, null metadata, generation filtering, per-turn versus next-turn settings, live reattachment, omitted request overrides, saved settings after a turn, rollout identity checks, malformed tails, and bounded large-output reads. Typecheck passed without errors or warnings.

The native bridge also passed `thread_settings_smoke` against installed Codex 0.154.0 in an isolated temporary CODEX_HOME, using metadata-only fixture records and no model requests: process 1 recovered Plan/high; an explicit Code/low update was recovered by process 2; a Plan/high update was recovered by process 3. Original account history was not mutated by this smoke test.

Final packaging: Tauri release `.app` build and formatting checks passed. Reopened the native app (PID 67199); it launched its configured Codex child and resumed the project. Codex's resulting persisted `thread_settings_applied` record reports `gpt-6-astra`, `high`, `plan`. The obsolete `lastModel` and `lastReasoningEffort` keys were absent from the saved Workbench preferences. Nine affected browser tests and all 30 Rust tests were rerun after the final missing-mode guard and passed.

## Permissions and session status controls (2026-09-14)

Added two native UI entry points: the header's status indicator opens Session status, and the composer Permissions button opens access controls. Neither uses slash commands. The dialog has Overview and Permissions tabs, keyboard/Escape support, explicit Apply, and independent loading/error states.

Permissions are discovered from Codex `permissionProfile/list` for the project; managed-disabled profiles remain visible but disabled. Approval choices are filtered through `configRequirements/read`. Existing-thread changes revalidate both lists in Rust, require an idle turn with no pending approvals, and call `thread/settings/update` with only explicit permission/approval changes. Model, mode, and effort are preserved. Full access has an inline scope explanation before Apply. New-conversation choices are ephemeral composer inputs and reach `thread/start` with the first message; omitted choices use Codex configuration. No permission preference is persisted in Workbench.

Status displays current Codex model, reasoning, mode, permissions, approval behavior, project/branch, provider/service tier, and copyable thread ID. Token usage comes from `thread/tokenUsage/updated` with the existing bounded Codex-rollout reader used to recover `token_count` after restart. The context meter explicitly shows last input divided by the model context window; cumulative usage is labeled separately. Account identity and quota windows come from `account/read` and `account/rateLimits/read`. Missing values remain unavailable, and account permission to use included quota is not inferred from percentages. Reads happen when the controls are opened/refreshed; there is no polling loop. Data returned to the frontend is whitelisted.

Validation: 10 Vitest tests and 33 Rust tests passed. All 24 browser tests passed across the full run and focused rerun (two initial text-formatting failures were corrected). Browser screenshots of both panels were inspected. Coverage includes explicit Apply/Cancel, first-message permissions, managed restrictions, denied changes retaining current access, restart recovery, active-turn locks, live usage updates, and missing usage/account data. The isolated real Codex 0.154.0 restart smoke now also asserts that `:read-only` with `untrusted` approvals survives two restarts alongside model/mode/effort, without making a model call or changing the user's thread permissions.

Final verification: frontend typecheck and formatting passed, and the Tauri macOS release bundle built successfully. The previous native app exited cleanly and the rebuilt app was reopened with the new controls. The final UI also keeps its tab/header controls visible while scrolling long status information. No slash-command handling was added.

## Concurrent tasks and thinking visibility — 2026-09-14

New task and Runs navigation stay available while other threads work. The bridge tracks active turns by thread, scopes interruption and permissions to the selected thread, keeps idle protection until every thread is idle, and interrupts all owned turns on confirmed quit. A rejected or uncertain start reconciles the affected thread without killing the shared server. Command-output retention keys include thread, turn, and item IDs. Settings-update notifications wake only the matching thread's waiter.

An Other tasks strip exposes background activity, completion, and pending questions. Returning reads settings and history from Codex. Unsent draft text/context/attachments remain associated with their thread for this app session; queued follow-ups continue on their original thread in the background. No thread settings are restored from app-local preferences. Live events received while history loads take precedence over older snapshots. Reload reconstructs running threads and waiting indicators from the backend.

Thinking is driven by Codex reasoning item lifecycle and `item/reasoning/summaryTextDelta`. Summary sections retain their index and render as collapsible Markdown; raw reasoning content and raw text deltas remain excluded. When no summary arrives the UI still shows task activity. Historical summaries are not labeled as live thinking without an observed active reasoning item. Protocol reference: https://learn.chatgpt.com/docs/app-server.

Validation: 11 Vitest tests and 34 Rust tests passed. The 27-test Playwright run passed 26 and exposed an initial workspace-restore guard regression; after the fix, all five relevant browser checks passed (including reload, concurrency, background follow-ups, thinking, and disconnect recovery). Typecheck reported zero errors/warnings; formatting checks and the Tauri macOS application build passed. New multi-thread protocol coverage verifies independent approvals/output, same-thread duplicate rejection, per-thread interruption, and idle protection. Screenshots `test-results/concurrent-tasks.png` and `test-results/thinking-stream.png` were visually reviewed.
