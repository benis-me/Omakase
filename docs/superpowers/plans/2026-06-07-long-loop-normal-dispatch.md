# Long Loop + Normal Dispatch

## Scope

Implement the first two remaining product gaps:

1. Long-running multi-agent loop: a user requirement added while a run is active becomes part of the completion criteria, triggers replanning, and blocks success until reviewed as met.
2. Normal/auto dispatch trust: normal mode must visibly assign real available agents across worker tasks, expose assignment before stream output, and have a real-agent smoke path that refuses builtin/scripted fallback.

Backlog after this slice:

3. Project knowledge/wiki productization.
4. TUI Plan/Detail focus, Agents focus, expansion, and keyboard navigation.
5. Web console visual/UX upgrade.
6. Codegraph deepening.
7. Desktop later, branch-isolated.
8. Release-grade reliability pass.

## Implementation

1. Add regression tests:
   - Mid-run `requirement` inbox input appends a user-sourced acceptance criterion and emits acceptance/replan events.
   - `normal` policy with multiple authenticated agents dispatches parallel worker tasks to multiple agent ids.
   - TUI view-model folds explicit assignment events into task agent state and activity.
2. Update core:
   - Preserve inbox item kind when applying user input.
   - For `kind: "requirement"`, append a pending user acceptance criterion before replanning.
   - Emit an `agent-assigned` event before each main/support agent stream starts.
3. Update CLI view-model:
   - Render assignment in activity.
   - Attach assignment to the matching task before token/tool usage arrives.
4. Add `scripts/smoke-real-normal-loop.sh`:
   - Uses `--mode normal` without `--agent`.
   - Requires at least two authenticated available agents.
   - Requires planner/reporter/wiki-curator/strategy events.
   - Requires at least two distinct real worker agent ids and no builtin/scripted agent ids.

## Verification

Focused:

```bash
pnpm --filter @omakase/core test -- control orchestrator-long-running policy
pnpm --filter @omakase/cli test -- view-model
bash scripts/smoke-real-normal-loop.sh --dry-run
```

Full:

```bash
pnpm check
git diff --check
bash scripts/smoke-real-normal-loop.sh
```

The real normal smoke is expected to fail at preflight when fewer than two
authenticated, available, non-builtin agents are detected. That is a valid
environment blocker, not a reason to fall back to offline/scripted agents.
