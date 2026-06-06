# Long-Running Multi-Agent Knowledge System Design

## Goal

Build Omakase into a long-running, product-grade multi-agent system that can keep iterating on complex tasks until acceptance criteria are satisfied, while continuously maintaining a useful project knowledge base and giving users a clear TUI-first experience.

This design explicitly does not cover the Desktop client and does not require self-modifying automation. Those can build on this foundation later.

## Product Decisions

- **Execution model:** Hybrid. Agents advance automatically, but user decision points are created when the system cannot safely or honestly decide.
- **User interruption model:** Risk-gated. The system asks the user only for destructive actions, conflicting requirements, repeated failures, insufficient evidence, or UX/product judgment that cannot be verified automatically.
- **Acceptance criteria:** Generated automatically by the Planner, visible and editable by the user throughout the run.
- **Stopping rule:** Completion-led by default. Unless the user explicitly sets token, cost, time, or iteration limits, the run continues until all acceptance criteria pass or a risk gate requires user input.
- **Primary UX:** TUI-first plus API/file compatibility. The TUI is the main interaction surface; lower-level `.omakase` files and `RunControllerClient` remain the durable interface for future Desktop and automation clients.
- **Reporting:** A Reporter Agent runs outside the main decision path and writes stage reports when the main flow asks it to.
- **Web:** `omakase tui` starts a local read-only server for reports, wiki, acceptance state, codegraph summary, and run status.

## System Shape

The existing Ralph loop remains the center:

```text
router -> planner -> workers -> reviewer -> replan -> continue/finish
```

The loop becomes iteration-aware:

```text
start
  -> generate acceptance criteria
  -> iteration N plan
  -> parallel workers
  -> reviewer evaluates criteria
  -> if all pass: finish
  -> if risk gate needed: wait for user
  -> otherwise: replan and continue with iteration N+1
```

The Reporter Agent is a side path:

```text
main loop checkpoint -> reporter input snapshot -> report artifact -> TUI/Web display
```

Reporter output may be referenced by future Planner/Reviewer prompts as context, but it must not directly change plan, task, acceptance, gate, or run status.

## Core State Model

### Acceptance Criterion

Each criterion is a durable object attached to a run:

- `id`
- `title`
- `description`
- `status`: `pending | pass | fail | unknown | needs-user`
- `evidence`: short evidence text and links to task ids, report ids, wiki entries, or event ids
- `source`: `planner | user | reviewer | replan`
- `createdAt`
- `updatedAt`

Planner creates the initial list. User input can add or modify criteria during a run. Reviewer updates criterion status after every review pass.

### Iteration

Each replan cycle creates an iteration record:

- `id`
- `index`
- `status`: `planning | running | reviewing | replanning | waiting-for-user | complete`
- `reason`
- `taskIds`
- `reviewSummary`
- `failedCriteria`
- `nextStrategy`
- `startedAt`
- `finishedAt`

The TUI should make the current iteration visible so users know why the system is still running.

### Risk Gate

A risk gate pauses automatic progress until the user responds. A gate includes:

- `id`
- `kind`: `destructive-action | requirement-conflict | repeated-failure | insufficient-evidence | ux-judgment`
- `title`
- `description`
- `options` when the system can propose safe choices
- `recommendedOptionId` when there is a defensible default
- `status`: `open | answered | cancelled`
- `answer`
- `createdAt`
- `answeredAt`

When a gate opens, the run enters a waiting state. User answers are written through the same durable control path used by TUI and future clients, then the run resumes or replans.

### Knowledge Event

The wiki remains human-readable, but the source of truth becomes structured knowledge events:

- `id`
- `kind`: `fact | decision | risk | task-note | verification | codegraph | report`
- `title`
- `body`
- `sourceAgentId`
- `runId`
- `iterationId`
- `taskId`
- `criterionId`
- `reportId`
- `confidence`: `low | medium | high`
- `createdAt`

Wiki markdown is rendered from knowledge events and existing wiki entries. This makes the knowledge base traceable instead of a single append-only markdown file.

### Report

Reporter Agent writes reports as structured artifacts:

- `id`
- `runId`
- `iterationId`
- `trigger`
- `title`
- `summary`
- `markdown`
- `createdAt`
- `sourceAgentId`

Reports are display artifacts and knowledge inputs, not control messages.

## Main Flow

1. A run starts through CLI/TUI/API.
2. Router classifies the request.
3. Planner generates:
   - initial plan,
   - acceptance criteria,
   - first iteration metadata.
4. Workers run in parallel according to the plan graph.
5. Agents emit activity, usage, tool events, and knowledge events.
6. Reviewer evaluates every acceptance criterion with evidence.
7. If all criteria pass, the run completes.
8. If criteria fail or remain unknown, the system replans and continues.
9. If a risk gate condition is met, the run waits for user input.
10. User additions or edits update criteria and trigger replan.

## Reporter Flow

The main flow may trigger the Reporter at these points:

- after the initial plan and criteria are created,
- after each reviewer pass,
- before and after replan,
- before opening a risk gate,
- after the user adds or changes requirements,
- when enough new progress has happened since the last report.

Reporter input is a bounded snapshot:

- run status,
- current iteration,
- acceptance criteria state,
- active and recently completed tasks,
- recent agent activity summary,
- recent knowledge events,
- wiki summary,
- codegraph stats.

Reporter output is persisted as a report artifact and a knowledge event. It does not mutate orchestration state.

## TUI Experience

The TUI is a long-running work console, not a log viewer.

The run detail view should expose these workspaces:

- **Plan:** phases, task tree, current iteration, why the loop is continuing.
- **Agents:** live agent status, task assignment, tokens, tools, elapsed time, expandable details.
- **Acceptance:** generated and user-edited criteria with status and evidence.
- **Knowledge:** new facts, decisions, risks, verification notes, wiki updates, codegraph summary.
- **Reports:** Reporter outputs and the local web URL.
- **Gate:** active risk gate, recommended option, and input mode for user answers.

The header should show:

- run status,
- current iteration,
- active agents,
- acceptance progress,
- latest report time,
- local server URL.

The input model:

- `[u]` appends a requirement or note during a run.
- Acceptance workspace supports adding or editing criteria.
- Gate mode captures the answer to the current risk gate.
- Existing stop, pause, resume, and attach behavior remains.

## Read-Only Local Web Server

`omakase tui` starts a local read-only server:

- bind address: `127.0.0.1`
- port: random free port by default, configurable later
- lifecycle: tied to the TUI client process, not the daemon
- data source: `.omakase` run records, reports, wiki, codegraph, and derived view-model state

The server displays:

- reports,
- wiki,
- acceptance criteria,
- iterations,
- agents,
- codegraph summary,
- raw events for debugging.

The first version has no write operations. It does not edit criteria, answer gates, or submit requirements.

## API And File Compatibility

The durable control path remains the compatibility layer:

- TUI writes user input and gate answers through control files or `RunControllerClient`.
- Daemon owns run mutation.
- Web server reads durable state only.
- Future Desktop can reuse the same client and files without becoming the source of truth.

New event types should be persisted in `RunRecord.events` so replay produces the same TUI state as live tailing.

## Error Handling

- If Reporter fails, the main run continues and records a report error event.
- If criteria generation fails, Planner falls back to a minimal criterion derived from the user request and opens a low-risk warning in the TUI.
- If Reviewer output cannot be parsed, the criterion status becomes `unknown`; repeated unknown results open an insufficient-evidence gate.
- If a user edits criteria while workers are running, the current iteration is marked superseded and a replan is scheduled after in-flight tasks settle or are cancelled safely.
- If the read-only web server cannot bind a port, TUI continues without web display and shows the server error.
- If knowledge persistence fails, the run continues but surfaces the persistence error in TUI activity and records it in the run event log.

## Testing Strategy

Unit tests use scripted agents and fake transports for deterministic behavior:

- Planner creates acceptance criteria.
- Reviewer updates criteria status.
- Failed or unknown criteria trigger replan.
- Risk gates pause and resume from control input.
- User-added requirements create or update criteria.
- Reporter artifacts are created on configured triggers and cannot mutate plan state.
- View-model replay reconstructs iterations, criteria, gates, reports, and knowledge state.
- Read-only web handlers return reports/wiki/acceptance/run status and reject write methods.

Product-path verification must also use real daemon/TUI runs:

- submit a complex task through `scripts/omakase.sh tui --cwd ... --agent codex`,
- confirm Planner output appears,
- confirm acceptance criteria appear,
- confirm worker/reviewer events update,
- confirm failed criteria cause replan,
- confirm user input changes criteria,
- confirm risk gate pauses and resumes,
- confirm Reporter writes reports,
- confirm the local web server displays read-only state.

## Implementation Slices

1. **Acceptance and Iteration Core**
   - Add acceptance criteria and iteration state to run records and events.
   - Make Reviewer evaluate criteria structurally.
   - Continue until criteria pass.

2. **Risk Gate and User Input**
   - Add waiting-for-user state.
   - Add gate events and control handling for answers.
   - Let user requirements update criteria and trigger replan.

3. **Reporter and Knowledge Events**
   - Add reporter role and report artifacts.
   - Add structured knowledge events.
   - Render wiki from traceable knowledge sources.

4. **TUI and Read-Only Web**
   - Add Acceptance, Knowledge, Reports, and Gate workspaces to TUI.
   - Start local read-only web server with TUI.
   - Display reports/wiki/acceptance/run status/codegraph.

## Non-Goals

- No Desktop client in this spec.
- No autonomous self-modification requirement in this spec.
- No browser write operations in the first web server version.
- No semantic call graph implementation in the first pass; existing syntactic codegraph remains the source until a dedicated codegraph enhancement is designed.
