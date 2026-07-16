---
name: ship-feature
description: Plan independent features, build each in an isolated git worktree routed to a chosen provider, then validate against the goal and fix gaps. A template for real, parallel-safe delivery.
version: 1.0.0
when_to_use: When a goal decomposes into independent features you want built concurrently without conflicts.
allowed-providers: [claude, codex, gemini, cursor-agent]
---

# ship-feature

A worked example of a **custom Dynamic Workflow** using Omakase's advanced primitives:

- `w.recall(...)` — pull in knowledge accumulated by earlier runs.
- `w.providers` — the available agents, so the workflow can **route** each feature.
- `w.isolate(label, fn)` — build each feature in its own **git worktree** (merged
  back on success) so concurrent agents never clobber each other's files. Outside
  a git repo this falls back to an isolated subdirectory.
- `w.goalMet()` + `w.loopUntil(...)` — validate against the goal's success criteria
  and fix remaining gaps, bounded.

Copy this folder into `.omks/workflows/` and run:

```bash
omks run "build a todo app with add, list and delete" --workflow ship-feature \
  --check "bun test"
```

This file is progressive-disclosure **L2** — loaded only when the workflow is selected.
The executable definition lives in `workflow.ts`.
