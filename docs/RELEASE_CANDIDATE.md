# Integrated 0.3.0 candidate

This is an **unreleased integration candidate**. The version number identifies the assembled code; it is not evidence of a published release or a native smoke-test pass.

## Included work

The integration preserves these exact verified source heads. Their original branches and pull requests remain available for focused review.

| Work                                                       | Source pull request                                   | Included head                              |
| ---------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ |
| Quick-open correctness and devalue security patch          | [#7](https://github.com/solo-novato/bindaas/pull/7)   | `a6b378114cb00a148f195d67fb1ebc924b793e81` |
| Ordered task queues, pause and recovery                    | [#11](https://github.com/solo-novato/bindaas/pull/11) | `a847faefea76470e924e7400e2d05f632e08ded1` |
| File-conflict recovery and editor I/O safety               | [#12](https://github.com/solo-novato/bindaas/pull/12) | `1ad2037b37d56f0748f85a1982c40eae323f2af7` |
| Explicit file references and frozen editor context         | [#13](https://github.com/solo-novato/bindaas/pull/13) | `70cb56506f55bc60310223670857ad06ec1a6dd4` |
| Scoped Explorer mutations and source-map-js security patch | [#14](https://github.com/solo-novato/bindaas/pull/14) | `70aba9abfce2093c990664bae58898f3e461a6d6` |

No Dependabot major-version batch is included. The integration adds no runtime dependency, process, polling, indexing, or recovery storage. Resource constraints are design choices; no measured memory advantage is claimed.

## Integration checks

Run the complete checks in [CONTRIBUTING.md](../CONTRIBUTING.md), including both browser engines, native tests, security audits and notices verification. Verify the successful remote CI run belongs to the integration PR's final head. A pass on an individual source branch is insufficient.

The combined journeys exercise frozen context through multi-step queue operations, background conversations and failures; editor comparison/reload without changing captured payloads; and selection capture, undo and draft preservation during file mutations. Existing feature suites remain part of the same run.

All six package/native version fields must agree on `0.3.0`. Keep the changes under the unreleased candidate until publication. Do not move any existing tag.

## Native smoke gate

Follow the existing tag-to-draft-DMG process only after the required automated checks pass. Before publishing that draft, test the actual DMG on an Apple silicon Mac and record its checksum, macOS version, installed agent versions and observed results:

1. Launch the installed app and open a disposable project with Codex or Claude Code. Check the single-agent setup path as well as the chosen agent's real message/approval flow.
2. Capture unsaved editor text, queue multiple follow-ups, change the buffer, and verify each queued step receives its original context. Exercise pause, resume, edit/reorder and failure recovery.
3. Let an agent change a file with local edits. Compare both versions, cancel a replacement, then exercise an explicitly confirmed save/reload. Verify unsaved work and undo remain usable.
4. Create, rename and move disposable files/folders to Trash. Check dirty-file refusals, selection capture after rename, pending-action controls and recovery from an unsuccessful operation.
5. Switch conversations and project windows with drafts and queued work. Check close/quit warnings and the new-project boundary.
6. Leave the app idle after completion and confirm ordinary responsiveness and absence of unexpected repeated work. Use the [profiling checklist](architecture/PERFORMANCE_CHECKLIST.md) for any resource measurements, including agent processes.

The opt-in installed-agent Rust tests and screenshot/style workflows have separate prerequisites. Their skipped status is not a smoke-test pass. Publish only after the actual artifact's native checks are recorded.
