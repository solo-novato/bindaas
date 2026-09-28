# Codex Workbench — Specification Pack

This pack is intended to be dropped into an empty/new repository and given to Codex as the specification for a one-shot v1 implementation.

## Files

- `PRODUCT.md` — product thesis, scope, workflows, success criteria.
- `UX_SPEC.md` — detailed user experience and visibility behavior.
- `ARCHITECTURE.md` — stack, process model, Codex App Server integration, security, lifecycle.
- `LLD.md` — modules, types, Tauri commands/events, state machines, algorithms.
- `IMPLEMENTATION_GUARDRAILS.md` — performance/safety rules and edge cases.
- `AGENTS.md` — repository-level instructions Codex should follow.
- `BUILD_PROMPT.md` — prompt to paste into Codex to build the project in one run.

## Recommended repository placement

After creating the repo:

```text
your-repo/
├── AGENTS.md
├── BUILD_PROMPT.md
└── docs/
    ├── PRODUCT.md
    ├── UX_SPEC.md
    ├── ARCHITECTURE.md
    ├── LLD.md
    └── IMPLEMENTATION_GUARDRAILS.md
```

`AGENTS.md` already tells Codex how to handle the files if they initially arrive together at repository root.

## One-shot usage

1. Put these files into the repo.
2. Open the repo with Codex.
3. Paste the contents of `BUILD_PROMPT.md`.
4. Let Codex implement and run its checks.
