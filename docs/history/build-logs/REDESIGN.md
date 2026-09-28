# Workbench experience redesign

Objective: make Workbench a distinctive, exceptionally smooth environment developers choose for sustained work. This is a redesign of the working experience, not a theme change. User preference and long-term enjoyment cannot be proved by automated checks alone; the shipped interaction quality and end-to-end workflows must be demonstrable.

## Evidence at the start of the redesign

The September 20 source still uses a full-width bottom composer, permanently competing side panels, several duplicated status/stop controls, and a narrow discovered-file dialog without keyboard selection. Command-K only focuses the composer. Concurrent tasks are a horizontal list with no search. Every tool event occupies a separate timeline row. Change review is a file list and a diff with no guided review workflow. These are functional foundations, but navigating them asks the user to manage UI rather than their work.

## Experience requirements and completion evidence

1. **Orient and move effortlessly.** A discoverable keyboard launcher connects actions, known files, and real Codex tasks. Contextual commands, reliable focus return, keyboard selection, loading/empty states, and rapid switching must work. Verify with browser interaction tests and rendered screenshots, including tasks running in the background.
2. **Keep attention on the task.** A deliberate focus layout, clear hierarchy, readable chat, restrained motion, and legible laptop layouts. Preserve panel preferences and the user's place. Verify layout at 1000, 1280, and 1440 pixels, light/dark appearance, keyboard operation, and reduced motion.
3. **Make conversations easy to follow.** Readable Markdown, compact inspectable tool activity, stable scroll while reading, clear live activity, and smooth transition to a final answer. No invented progress. Verify interleaved streaming, long messages, long history, and completion/connection loss.
4. **Make composing and responding feel immediate.** A comfortable composer, understandable context/attachments, clear Plan/Code and model settings from Codex, well-scoped follow-up behavior, and questions that fit the conversation. Verify text/image/file input, retry, queue, permissions, and return to drafts across task switches.
5. **Close the loop through review.** Review changed files and actual check outcomes, navigate changes without losing the conversation, and prepare useful follow-ups from a specific file/hunk. Preserve pre-existing-change attribution, dirty buffers, and explicit side effects. Verify multi-file and large diffs, non-Git projects, and conflicts.
6. **Feel dependable throughout.** Recoverable loading/error states, no unexpected focus or scroll jumps, no unrelated task interruptions, accurate background attention indicators, and a quiet idle process. Verify the full existing integration suite plus new journey tests, appropriate native build, and launch/lifecycle evidence.

## Delivery stages

- Delivered: launcher, focus layout, bounded activity grouping, change-review workspace, conversation reading/navigation, and integrated task/composer layout.
- Delivered additionally: attachment inspection, dedicated proposed plans, and reported task progress.
- Next: complete the live native workflow and resource audit, and address remaining low-information layouts.
- Final: end-to-end visual/accessibility/performance audit, native build and launch, then review the entire objective against these requirements.

No Codex model/mode/effort/permission values will be persisted as Workbench preferences. No telemetry, engagement tricks, background indexing, or always-on service will be added to make the tool feel active.

## September 20 delivery evidence

Implemented the first navigation and conversation improvements:

- A native-dialog launcher with search, keyboard selection, categories, contextual disabled states, focus restoration, task history refresh on explicit request, and known-file opening. No indexing or idle API requests were added.
- Focus mode centers the conversation and composer, preserves independent panel choices, and persists only UI navigation state. Shortcuts are discoverable in the launcher. Modal dialogs isolate global shortcuts.
- Consecutive successful completed actions can collapse into factual summaries. Live commands, failed commands, and agent messages stay visible. Expanded command buffers are scoped by thread/turn/item. Inspecting command details stops auto-follow; loading earlier activity preserves the scroll offset.
- The composer grows up to a bounded height and returns to its compact size after sending. Context chips open a keyboard-accessible text preview. IME composition does not accidentally send a message.

Validation: 34 Playwright journeys passed in one final run (including the original regression suite); 12 Vitest checks and 34 native Rust tests passed. Typecheck reported zero errors/warnings, and formatting passed. Visual checks cover the launcher at 1000, 1280, and 1440 pixels, focus workspace, and activity inspection. Screenshots are stored in this directory. The final native macOS package passed with the scroll fix included and was opened successfully.

The old temporary Cargo launcher/cache had been cleaned since the previous session. The installed toolchain is a local Rust toolchain; missing locked crates were restored into `a temporary Cargo cache`. The build uses that toolchain directory in PATH and `CARGO_HOME=a temporary Cargo cache`.

### Completion audit against the full objective

- R1: Core launcher/navigation journeys demonstrated. Task navigation still needs broader visual refinement beyond the existing horizontal task strip and Runs screen.
- R2: Focus layout and laptop widths demonstrated. Light mode, reduced-motion behavior, broader contrast checks, and the overall shell hierarchy still need the final audit.
- R3: Activity compaction and inspection demonstrated. Long streaming conversations, search navigation, restoration of reading position across task switches, and final-answer emphasis still need work/evidence.
- R4: Growing drafts and inspectable text context demonstrated; previous attachment/queue/question tests remain green. Attachment presentation and the placement of the composer/questions within the overall experience need further design.
- R5: Review workspace delivered and verified below. Conversation reading position across review/task switches and a broader live review journey remain to be completed.
- R6: Existing safety and lifecycle tests pass. Native launch is verified. Live interaction review and a comprehensive end-to-end/performance audit remain.

The objective is not achieved yet. Continue from these implemented components; do not replace the goal with launcher/focus scope. Next: improve conversation reading/navigation and the task/composer hierarchy, then audit the complete experience.

## September 21 — review workflow delivered

The Changes destination is now a dedicated workspace with a searchable file rail, previous/next file controls, an unreviewed filter, explicit review marks, patch totals, observed command/check outcomes, and a direct route back to chat. Explorer/inspector preferences are preserved while duplicate panels are removed from this destination.

Review marks apply to the exact patch. A changed patch needs review again; truncated/missing patches cannot be marked reviewed. Marks are session-only UI state, retained through Chat/Changes navigation in the same scope and cleared on project/thread/turn/source/Git-scope changes. The retained patch text is bounded by the current diff. These marks are user acknowledgements, not Codex settings or claims that tests passed.

The diff supports hunk navigation across its 160-line render window, file metadata disclosure, whole-file or hunk context, and prepared Explain/Check regressions follow-ups. Existing prompt text is preserved, the context is previewable/removable, and no turn is sent automatically. Selected text is used only if both selection endpoints belong to this diff. Context is capped with an explicit truncation label. Deleted/renamed file metadata and no-newline markers remain available.

Related fixes found through the journey tests:

- Completed non-Git tasks keep the Codex diff when entering Changes.
- Files without a patch can be selected and show a useful explanation.
- At narrow widths, the inspector drawer opens on request instead of covering the initial Open project action. Escape closes it and returns focus; desktop panel preference remains intact.
- Redundant review headers and always-visible Git metadata were removed so a 1000 × 800 viewport gives more space to changed code. Dark and light screenshots were visually inspected.

Evidence: all 40 Playwright journeys passed in the final full run (35.8 seconds), including six new review/responsive journeys. 13 Vitest checks and 34 Rust tests passed. Svelte check reported zero errors/warnings; formatting passed. Native release build/package passed (43.61 seconds). The old idle app was closed through its normal quit flow and the rebuilt package opened. Browser journeys use the desktop fixture; native process launch is not a substitute for real interactive smoke testing.

Artifacts: `review-workspace.png`, `review-dark-1000.png`, `review-light-1000.png`.

### Remaining completion audit

The full objective remains active. The review workflow is concrete progress, not completion of the overall redesign. Outstanding work includes preserving conversation reading positions across view/task switches; stronger final-answer/task hierarchy; integrating attachments/questions/composer into that hierarchy; and the final keyboard, reduced-motion, live interaction, and quiet-idle audit. A readable review screenshot and passing regression suite do not prove those requirements.

## September 21 — conversation reading and summary delivery

Chat retains a reading anchor and expanded activity across Files, Changes, and task navigation. The session-only cache is limited to 20 views and 400 retained expansion keys per view; it contains UI metadata, not Codex settings or copied conversation text. Reading stays anchored as earlier content grows and background messages arrive. Explicitly sending a message resumes following. If the anchor has left the loaded history, a notice explains the fallback to available activity. This does not persist reading positions across app restarts or retain fetched command-output pages.

Conversation search has match counts and previous/next navigation. Closing search clears the filter, restores the previous reading position, and returns keyboard focus to the transcript. Request navigation and a Read answer action let readers move directly to useful content. Answer emphasis uses Codex's explicit `final_answer` phase; missing phase is not inferred from completion.

The reported empty Thinking summary was also investigated against real Codex data. The selected saved conversation contained 2,462 reasoning items with no nonempty summaries. The current model catalog defaults summaries to `none`, and Workbench previously omitted the turn's summary request. Older recorded contexts include `auto`, so the catalog default alone does not establish the cause of every historical omission.

New turns explicitly send `summary: "auto"`. Live ephemeral, read-only probes using the configured Codex executable confirmed summary events with explicit auto/detailed requests. The exact Workbench turn-only request returned no summary on one run and a 33-character streamed summary on a repeat: summary availability is intermittent, not guaranteed per turn. No global Codex config, model, effort, mode, or permission setting was changed. Empty reasoning items remain available for live activity state but no longer create empty disclosures. Only text supplied in Codex summary fields is displayed; older missing summaries cannot be recovered by this change.

Validation: 45 Playwright journeys, 14 Vitest checks, and 35 Rust tests passed. Svelte check reported zero errors/warnings; frontend formatting and formatting of changed Rust files passed. Five new browser journeys cover reading restoration, growth/search, expansions/following, explicit answer phase, and empty-summary lifecycle. Screenshot: `conversation-answer.png`.

The native release package built successfully (Rust release compilation: 18.54 seconds). Workbench exited through its normal quit flow and the rebuilt app was opened. Live summary probes verify the protocol; browser tests verify rendering. These are separate checks, not a claim of a complete live native interaction audit.

The broader redesign remains unfinished: task/composer hierarchy, attachment/question integration, and the final accessibility, live interaction, and quiet-idle audit remain.

## September 21 — integrated task and composer layout

The composer now belongs to the main work area, with one mounted textarea across navigation. The explorer and inspector use the full remaining height. Task details disclose the original prompt and Codex-reported settings; one Stop control remains in the composer. Attachment chips expose name, kind, and size rather than relying on hover text.

The title bar Tasks switcher replaces the unbounded horizontal task strip. It opens the existing searchable keyboard launcher and loads history on explicit request. A count reflects observed running turns, attention entries sort first, and a direct action returns to a background task that needs input or reports an error/disconnection. Drafts and actual thread settings still restore through their separate existing paths. No polling, new dependency, or native API was added.

Crowded-layout testing found send controls below the viewport and overlapping activity when a long draft, attachments, and a question competed for height. The composer and approval region now shrink within limits, the transcript retains a minimum readable height, and the question footer stays pinned within its scrolling region. The stress journey verifies hit testing and bounds for Send and Submit answers at 1000, 1280, and 1440 × 800, then submits the question and confirms the draft survives. Another journey exercises 26 concurrent tasks, direct attention navigation, keyboard task search, and return to an unsent draft.

Artifacts: `task-switcher-1000.png`, `composer-question-1000.png`, `composer-question-1280.png`, `composer-question-1440.png`, and `composer-context.png`. These are browser fixtures, not claims of a complete native live-use audit.

Final validation: all 47 Playwright journeys passed (27.4 seconds), 14 Vitest checks passed, Svelte check reported zero errors/warnings, and frontend formatting passed. No Rust source changed in this stage; its 35-test suite passed in the preceding stage. The native release package built successfully (24.34 seconds of Rust release compilation). The previous app exited normally and the rebuilt package was opened.

The original objective remains active. Remaining evidence/work includes richer attachment inspection, full keyboard and reduced-motion checks, contrast and focus review across all destinations, live native interaction through a complete task/review/follow-up journey, and measured quiet-idle/resource behavior. The existing empty inspector and other low-information states should be evaluated during that audit rather than assumed polished because they pass functional tests.

## September 21 — attachment inspection and explicit plan handling

Attachment chips open a keyboard-accessible viewer on demand. Images have fit/actual-size controls, dimensions, and decode-error feedback; text previews are bounded at 64 KiB without cutting UTF-8 characters. Preview and send share snapshot integrity checks. Original-file edits do not alter the attached copy, and unregistered IDs cannot select arbitrary files. Unsupported binaries remain attached. The viewer supports retry, removal, slow-load cancellation, and focus restoration. The existing transitive base64 0.22.1 crate is now a direct dependency for image transport; no image service or asset-protocol permissions were added.

The user's request to treat plans separately uncovered that native `plan` items and deltas were flattened into messages. They now retain a distinct type in streaming and history. A bordered Proposed plan card renders the final authoritative text, exposes Read plan, and offers Revise plan or Prepare implementation only for a complete, untruncated plan in a completed selected turn. Both prepare an inspectable reply after Codex confirms the explicitly chosen mode. Neither sends automatically; failed mode updates preserve the existing draft. Viewing a plan never changes mode. Structured progress updates have a separate bounded list, retaining reported statuses and using past-tense labels once the turn ends.

An axe-core audit found insufficient shortcut/diff-number contrast and a missing accessible name on the file editor. These were corrected. The final automated audit reports no WCAG A/AA violations at its 16 checked destinations/states in dark/light appearance, and checks the active status indicator under reduced motion. See `accessibility-audit.json`. This is scoped automated evidence, not a claim of full accessibility conformance or a substitute for manual screen-reader testing.

Validation: 53 browser journeys passed in one final run (43.1 seconds), including attachment lifecycle, plan streaming/history/handoff/failure paths and the accessibility audit. 15 frontend unit checks and 38 native tests passed; typecheck reported zero errors/warnings and formatting passed. Artifact: `proposed-plan.png`; text preview: `attachment-text-preview.png`.

A live ephemeral Codex Plan-mode probe used the same capability handshake as Workbench, read-only sandbox, and no tool calls. It returned one plan through 174 deltas, with 828 characters in the authoritative completed plan. Native release packaging passed (39.47 seconds of Rust release compilation), the old app exited through its normal quit flow, and the rebuilt package was opened. This verifies live protocol support and package launch separately from the still-pending complete native UI journey.

To repeat the optional accessibility audit, install axe-core outside the application (`npm install --prefix /private/tmp/workbench-ux-audit --no-package-lock --ignore-scripts axe-core`) and set `WORKBENCH_AXE_PATH=/private/tmp/workbench-ux-audit/node_modules/axe-core/axe.min.js` when running `npm run test:ui`. Without that variable only the extended audit is skipped. The audit dependency is not shipped with Workbench.

Still required for the overall objective: native live-use evidence across a complete task/review/follow-up journey, final keyboard/focus review across all destinations, measured quiet-idle/resource behavior, and review of low-information states such as the empty inspector. The objective remains active.

### Plan action follow-up

Repeated plan actions now replace intact prepared instruction paragraphs for the attached plan, rather than appending duplicate or opposing boilerplate. User-edited paragraphs remain untouched, and the plan remains attached once. A browser regression covers repeated implementation/revision actions, preservation of edited feedback, and the absence of automatic sends. All 54 browser journeys passed (28.5 seconds), including the optional accessibility audit; 15 frontend unit checks, typecheck, and formatting also passed. Rust code is unchanged from the preceding 38-test validation.

Two read-only process snapshots, 112 seconds apart, showed the already-open native app at 0.1% then 0.0% CPU, with resident memory approximately 90 then 89 MiB. The WebKit process started alongside it reported 0.0% CPU in both samples. These are sampled process observations, not a continuous idle benchmark or definitive WebKit attribution; the full native workflow/resource audit remains pending.

The follow-up native release package passed (17.95 seconds of Rust compilation). The previous app exited normally, and the updated package reopened successfully.

## September 21 — pane and inspector interaction audit

Replaced mouse-only pane handles with focusable, labelled separators supporting arrow/Shift-arrow resizing, Home/End limits, Enter/double-click reset, and captured pointer dragging. Sizes save on completed interaction rather than every pointer move or repeated keydown. Displayed widths adapt to preserve 480 px for the main area at supported window sizes without overwriting the user's preferred widths. Closing either pane returns keyboard focus to its reveal control; opening the inspector moves focus inside it.

The empty inspector now describes the selected source and observed state: last Git snapshot, unavailable Git, waiting for task edits, no selected task, or no file changes reported in loaded history. Explicit refresh discovers external changes, and a completed proposed plan can be opened from Files without changing mode or sending a turn. The previous generic instruction to select an activity was removed because it did not describe a supported inspector action. Screenshot: `inspector-plan.png`.

All 57 browser journeys passed (30.0 seconds), including keyboard/pointer resizing, the 1151 px drawer boundary, preserved width preferences, explicit refresh, panel focus return, active/completed task states, and plan navigation. The 16-state axe audit passed with the new separators included. Fifteen frontend unit checks passed. These remain browser fixture journeys rather than native UI automation.

A native automation preflight returned `false` for macOS System Events' `UI elements enabled`. This prevents the pending native interaction audit through Accessibility automation in the current environment; no system permission was changed. Native packaging and process launch can still be verified independently. The broader objective remains active pending the native workflow and final resource audit.

The final focus pass also made explorer reopening skip disabled controls before a project is open, and removed the ineffective inspector toggle from Settings. The five affected browser/accessibility journeys passed again (5.6 seconds); typecheck reported zero errors/warnings and formatting passed. Final native packaging passed (18.94 seconds of Rust compilation). The previous instance exited through the normal guarded quit flow; the final package reopened as PID 82740.

Native process observations are recorded in `native-process-sample.json` and `native-process-second-sample.json`. Across the first 60.04 seconds, the core app used 0.01 CPU seconds (0.017% average) and its Codex child used 0.09 CPU seconds; app RSS ranged from 76.77 to 98.05 MiB. The second interval recorded no additional core CPU time at ps precision, with app RSS 79.73–79.86 MiB. OS-hosted WebKit processes are excluded because parentage did not establish ownership. The running package differed from the final package only in the two subsequent frontend focus/control fixes; native code was unchanged.

These measurements demonstrate low sampled native process usage, not completed idle-shutdown verification. A Codex child remained present beyond five minutes of app runtime. The selected conversation differed from the earlier audit context, and its lifecycle log recorded completion, but logs do not establish the running backend's full active/pending state. A separate 75-second ephemeral, read-only, prompt-free app-server probe observed only remote-control/thread/MCP startup notifications, not periodic background traffic; that hypothesis was not confirmed. Do not claim idle shutdown passed or alter active-work protection based on these indirect observations. Remaining verification: one complete native task/review/follow-up journey and confirmation of live idle state plus child release after its configured timeout.

## September 21 — installed-Codex idle verification and handoff audit

Added an opt-in native test, `src-tauri/tests/live_idle.rs`, that runs the production Rust manager on a multithreaded runtime against the configured installed Codex wrapper. It starts an ephemeral read-only thread in a temporary directory, confirms the thread and manager are idle, waits for the three-second test timeout, checks that the owned process was reaped, then verifies a fresh connection responds. It sends no model turn, reads no user project, and cleans up only the isolated manager's processes. Ordinary test runs skip it so they remain independent of login/network access.

The installed CLI reports 0.155.0 and Rust reports 1.91.1. The first sandboxed attempt disconnected during startup; the authorized run outside the sandbox passed: child release and restart took 3.74 seconds, total test duration 4.34 seconds. All 38 regular Rust tests then passed, with this opt-in test correctly ignored by default. Formatting of the new Rust test and updated README passed. Production runtime files did not change, so the already-open package remains current.

This proves that the native manager can release and restart a genuinely idle real server. It does not establish why the previously observed open workspace retained its server, nor prove that its live backend met all idle conditions. Those distinctions remain explicit. Accessibility preflight again returned `false`; the full native UI journey and its observed live-state/idle transition still require macOS Accessibility access or a manual native verification run.

README now reflects the actual launcher/composer/focus shortcuts, installed toolchain location, source of Codex settings, review workflow, proposed-plan actions, and repeatable opt-in lifecycle check. The earlier README instructions for a removed temporary toolchain and for ⌘K focusing the composer were stale.

### Remaining completion gate

The delivered changes have browser interaction, scoped accessibility, fixture/native integration, installed-Codex protocol/lifecycle, build, launch, and sampled CPU evidence. The remaining gate is native use: task → approval/question → completion or proposed plan → review → follow-up, including recovery/dirty-file protections, plus the performance checklist's native editor/diff close-and-settle observations and a confirmed idle transition after the live backend is idle. Browser mocks and the isolated lifecycle test do not substitute for that scope. No further feature expansion is required merely to wait for Accessibility access. Completion is unproven.

Accessibility availability was rechecked in three consecutive goal turns and remained `false`. No alternative native UI automation capability is available in the session. Independent implementation and validation work is complete to the extent described above; the remaining native interaction gate requires changed macOS permission state or a manual native verification run. The goal is therefore blocked on that external condition, rather than marked complete.
