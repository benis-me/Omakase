# Dynamic Workflow Script Runtime

## Goal

Implement Omakase dynamic workflows as first-class JavaScript workflow scripts, executed by a Bun-based runtime and surfaced through the same run/event/store/view pipeline as normal orchestrator runs.

## Product Contract

- A workflow script is a persisted artifact attached to a run.
- Scripts orchestrate through a host API: phases, parallel agents, reporter requests, wiki updates, checkpoints, and logs.
- Scripts do not receive direct filesystem or shell APIs; they must spawn Omakase agents through the host.
- The host enforces max concurrency and max total agents.
- TUI/Web/API consumers replay the same durable `OrchestratorEvent` stream; workflow state is stored in `RunRecord.workflow`.
- Reporter and wiki-curator work remains out-of-band support activity, not fake tasks inside the main plan.

## Implementation Steps

1. Add dynamic workflow types, validator, in-memory test runner, and Bun JSONL IPC runner.
2. Add `DynamicWorkflowRun` to bridge workflow requests into `AgentRuntime`, `PlanGraph`, `RunStore`, reports, and knowledge events.
3. Extend `RunRecord`, `OrchestratorEvent`, core exports, and view-model labels for workflow lifecycle events.
4. Add CLI command `omakase workflow run <script.js>` with persistent `.omakase/runs` output.
5. Verify with unit tests, typecheck, and a real Bun workflow smoke.
