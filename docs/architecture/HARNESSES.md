# Agent integrations

Workbench defaults to Codex. Claude becomes visible in the composer, Runs filters, task switcher, and session controls after **Settings → Integrations → Connect Claude Code** succeeds. Switching agents opens that agent’s new-conversation draft. Existing conversations keep their native agent, identifiers, history, settings, and approvals. Drafts are isolated by conversation, or by agent for a new conversation.

## Native setup

Install the unmodified Claude Code CLI, version **2.1.274 or newer**, and sign in using `claude auth login --claudeai` for a Claude subscription, or `claude auth login --console` for Console. An existing `ANTHROPIC_API_KEY` environment configuration is also supported by the native CLI; the desktop process must inherit that environment. Setup offers an optional executable override, installation documentation, connection errors, and a retry action.

Connect checks version, the native authentication status, and an initialization handshake. Only the executable path and enabled preference are saved. Workbench never reads credential files or copies subscription tokens/API keys. Authentication stays with the installed CLI. Model choices come from the CLI initialization response, with an explicit native-default option if no catalog is reported.

References: [Claude CLI](https://code.claude.com/docs/en/cli-reference), [headless use](https://code.claude.com/docs/en/headless), [embedding the unmodified CLI](https://code.claude.com/docs/en/legal-and-compliance).

## Boundary and identity

`src-tauri/src/agents.rs` exposes `agent_*` Workbench operations and owns the registry. Native Codex operations remain in `codex/` and `commands.rs`; Claude process/control operations and transcript parsing live in `claude/`. The frontend uses `src/lib/api.ts` and normalized `agent://` events. Neither frontend views nor generic commands construct native protocol requests.

Conversation references are `codex:<native-id>` and `claude:<native-uuid>`. Native IDs are unwrapped only inside the adapter boundary. A native turn or item ID is scoped by its conversation. Codex connection generations apply to its shared app-server; Claude generations apply to each independently owned session process. A disconnect or obsolete event from another agent/session cannot clear the selected conversation’s approvals or state.

Settings schema 2 migrates project → last-conversation references and pins. The previous file is preserved as `settings.pre-agents-v1.json`. Existing workspace references are accepted and qualified when restored. Native history files are never rewritten by migration.

An additional harness needs a registry variant, implementations for the explicit operations, event normalization, native authentication/history integration, and a capability declaration in `src/lib/harness.ts`. Unsupported operations must fail explicitly at the backend and remain absent or disabled in the UI. There is no generic shell invoke or transcript conversion endpoint.

## Capabilities

| Behavior                                               | Codex                             | Claude                                                                 |
| ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------- |
| Independent conversations and concurrent runs          | Yes                               | Yes                                                                    |
| Streamed text and observable tools                     | App-server events                 | CLI stream-json                                                        |
| Tool approvals and questions                           | Native requests                   | Native control requests; multi-select supported                        |
| Plan / Code                                            | Native collaboration modes        | Native permission-mode control                                         |
| Follow-up during an active turn                        | Immediate steering, or Queue next | Queue next                                                             |
| Images and file snapshots                              | Native Codex inputs               | Native Claude content blocks                                           |
| Model selection                                        | Native model list                 | Native initialization catalog                                          |
| Reasoning effort / permission profiles / Fast controls | Native Codex controls             | Not exposed by this adapter                                            |
| Changes                                                | Native task diffs and shared Git  | Reported file operations and shared Git                                |
| Token/cost display                                     | Reported native fields            | Latest result usage and reported API cost; unknown fields stay unknown |
| Persistent history                                     | Native thread APIs                | Read-only native project transcripts                                   |
| Rename / archive                                       | Native APIs                       | Workbench metadata; native files remain untouched                      |

Claude inherits CLI/project permission rules. Codex’s Workbench full-access default never crosses into Claude. Leaving Claude Plan mode requires its native permission decision. If native plan text is unavailable, Workbench does not manufacture it.

## Runtime and history

Each attached Claude session owns one CLI process using `--input-format stream-json`, `--output-format stream-json`, partial-message streaming, replayed user messages, and `--permission-prompt-tool stdio`. Workbench initializes the control channel, sends user content, handles permission/question replies, and targets interrupt/model/mode changes to that process. No Node or Python runtime is required in the packaged app.

Processes stay available for follow-ups until the configured idle deadline. Turns, approvals, pending control requests, and observed background tasks prevent idle shutdown. The idle task waits for events/deadlines and rechecks eligibility before stopping. Process groups are owned and reaped; unexpected loss preserves an unknown outcome. Requests are bound to session + generation, resolved once, and expired on disconnect. Background tasks are visible activity items and keep a turn active until observed completion.

Claude stdout uses bounded JSONL frames; stderr is drained privately. Only observable text/tool activity is normalized; private thinking/signatures are excluded. Text emissions are coalesced to a 40 ms cadence, tool previews are bounded, active timelines retain at most 400 items, and recent cached turns have an 8 MiB budget (apart from the current turn).

Native history reads only the project’s encoded directory under `CLAUDE_CONFIG_DIR/projects` (or `~/.claude/projects`). UUID, project `cwd`, and symlink checks precede access. Parent-UUID chains select the active branch rather than mixing rewound branches. List metadata uses bounded head/tail reads. Transcript reconstruction uses the most recent 32 MiB and explicitly reports when older data is outside that window; the native CLI retains the full conversation. Turns and items page explicitly. Historical outcomes that the transcript does not establish remain **Status unavailable**.

Both agents use the same working directory and may run concurrently. A shared-folder indicator appears when multiple conversations are active. Repository changes are shared and cannot be attributed exclusively to one agent. Dirty editor buffers retain their existing protection.

## Verification

```sh
npm run check
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run test:ui
npm run tauri -- build --bundles app
```

`tests/fixtures/claude-cli.mjs` is a deterministic native-protocol fixture used only by Rust tests. Coverage includes initialization, stream/tool normalization, native permissions, exact approval routing, multi-select answers, interruption, crashes, concurrent sessions, background work, and idle release. Browser fixtures cover opt-in, isolated drafts, native history, scoped disconnects, queue semantics, setup errors, and laptop layouts in both themes.

The opt-in installed-CLI smoke runs in a disposable project. It verifies a real text turn, read-only native history, process shutdown, and resumption in a fresh process:

```sh
CLAUDE_WORKBENCH_LIVE_TURN=1 cargo test --manifest-path src-tauri/Cargo.toml \
  --test claude installed_claude_protocol_and_disposable_turn -- --ignored --nocapture
```

Without that environment variable, the same ignored test checks native authentication and initialization without sending a model turn. Native histories from disposable smoke runs remain owned by Claude; tests do not delete user CLI history.

Laptop UI verification with the browser protocol fixture: [dark theme](ux/agents-dark.png), [light theme](ux/agents-light.png).
