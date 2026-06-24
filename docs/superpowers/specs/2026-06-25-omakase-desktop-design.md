# Omakase Desktop — Design Spec

- **Status:** Approved (design gate passed 2026-06-25). Execution mode: autonomous to completion.
- **Date:** 2026-06-25
- **Author:** Claude (Opus 4.8, 1M) + Ben
- **Supersedes:** the OpenTUI single-column TUI rebuild (`feat/tui-rebuild`). The TUI is removed.

## 1. Summary

Omakase Desktop is an Electron application: **a cockpit for handing a spec to autonomous, long-running, multi-agent loops and letting them complete the work**, with DevDock-style project management built in. "おまかせ / omakase" = "I leave it to you" — the product metaphor for delegating work to autonomous agents.

The orchestration engine already exists in `@omakase/core` (a Ralph-loop orchestrator, resumable supervisor, plan graph, spec/TDD/dynamic workflows, wiki + codegraph knowledge) on top of `@omakase/daemon` (a dependency-free agent runtime that detects local agent CLIs and streams a unified `AgentEvent` protocol). This was deliberately preserved when the TUI was cleared. **We are not rebuilding the engine.** We are:

1. Building a new Electron front end (replacing the TUI) that mirrors DevDock's tech stack and design language.
2. Evolving persistence into a `.omks/` workspace directory (git-friendly authored files) + a per-workspace SQLite database (high-volume machine-written run/event data).
3. Adding DevDock-style project management (scripts, ports, terminals, "open with", git) as a built-in workbench per workspace.
4. Completing the spec-driven loop models (Spec / Mission / Workflow / Task) and an autonomy + control model informed by Factory.ai Droid, Anthropic's agent patterns, and the Ralph loop.

### Reference material

- DevDock (`/Users/ben/Projects/DevDock`) — tech stack + visual design reference.
- Factory.ai Droid — autonomy dial, spec-mode, Missions (orchestrator/worker/validator), files-as-memory.
- `docs/research/spec-driven-autonomous-agents-2026.md` — Ralph loop, Anthropic dynamic workflows, loop engineering, spec-driven development, orchestration primitives (~140 primary sources).

## 2. Goals & non-goals

**Goals**

- A complete, OSS-grade desktop app (no MVP / stubs). Every surface fully usable.
- Reuse `@omakase/core` + `@omakase/daemon` unchanged at the seams; extend, don't fork.
- `.omks/` workspace + SQLite storage, fully replacing the `.omakase/` file scheme.
- Agent cockpit is the primary surface; DevDock-style dev tools are built-in per workspace.
- Long-running runs survive app close (detached daemon handoff) and resume on reopen.
- `pnpm -r typecheck && pnpm -r build && pnpm -r test` stays green; new code is tested.

**Non-goals (v1)**

- No cloud sync / multi-user / accounts. Local-first only.
- No remote web viewer in v1 (the read-only HTTP server is removed; an optional `serve --http` may return later).
- No bundled LLM. We orchestrate the user's locally installed agent CLIs (claude, codex, etc.), exactly as today.
- No mobile app.

## 3. Architecture

The Electron process model mirrors DevDock 1:1 (main = `AppController` + services; preload = typed bridge; renderer = React + Zustand).

```
Omakase Desktop (Electron 42, electron-vite)
├── main  (Node)                                   ≈ DevDock AppController + services
│   ├── embeds @omakase/core      (orchestrator / supervisor / loops / knowledge)
│   ├── embeds @omakase/daemon     (agent detection + AgentEvent streaming)
│   ├── @omakase/storage  [NEW]    (.omks files + SQLite; implements RunStore/SessionStore + repos)
│   ├── services [NEW, DevDock-parity]:
│   │     ProjectScanner · ProcessManager(node-pty) · PortService(lsof) ·
│   │     AppLauncher(open-with) · GitService · FileWatcher
│   ├── WorkspaceHost              (owns the active orchestrators, bridges OrchestratorEvent → IPC)
│   ├── DaemonBridge               (spawn/attach detached `omakase serve` for background runs)
│   └── ipcMain.handle(...) + webContents.send(...) event stream
├── preload → contextBridge → window.omakase (typed API; channel-named like DevDock api.ts)
└── renderer (React 19 + Zustand 5 + Tailwind v4 + shadcn/ui + lucide)
      ├── Workspace sidebar (left): switcher + Runs/Specs/Agents/Memory/Workflows/Dev
      ├── Detail pane (right): editors + the single-column run cockpit
      └── ⌘K command palette · theme · settings
```

**Process / ownership model**

- **In-process by default.** The Electron main process hosts orchestration in-process for live, in-app runs. The full `OrchestratorEvent` stream is forwarded to the renderer over IPC. This is the fast path and the default.
- **Detached handoff for 24/7.** "Run in background" spawns (or reuses) the existing detached daemon (`omakase serve`) which continues the run after the app closes. The app and the daemon share the same `.omks/` workspace + SQLite DB and coordinate through the existing file-based `ControlCommand` plane and run checkpoints. On reopen, the app reattaches by tailing SQLite + the run's checkpoint.
- **Single writer per run.** A run is owned by exactly one process at a time (the app or the daemon). Ownership is tracked via the daemon lock + a `runs.owner` column. SQLite runs in WAL mode so the non-owner can tail/read concurrently.

## 4. Monorepo layout

```
packages/
  daemon/      @omakase/daemon   (unchanged)
  core/        @omakase/core     (extended: new run modes, autonomy, validator role)
  storage/     @omakase/storage  [NEW] .omks + SQLite, RunStore/SessionStore/repos, migrations
  cli/         @omakase/cli      (TUI removed; headless run/agents/serve kept; used as detached engine)
apps/
  desktop/     omakase-desktop   [NEW] Electron app (electron-vite + React)
```

- Add `apps/*` to `pnpm-workspace.yaml`.
- `@omakase/storage` depends on `@omakase/core` (for the types it persists) + `better-sqlite3`. It exports `SqliteRunStore`, `SqliteSessionStore`, the knowledge repositories, the `.omks` file readers/writers, and a migration runner. The `RunStore` / `SessionStore` interfaces in core are unchanged; storage provides new implementations, so core stays storage-agnostic.
- `apps/desktop` depends on `@omakase/core`, `@omakase/daemon`, `@omakase/storage`. In dev, Vite resolves these via the packages' `development` export condition (→ `src/index.ts`), so no pre-build step is required during app dev.
- Native modules (`better-sqlite3`, `node-pty`) are rebuilt for Electron's ABI via `@electron/rebuild` / electron-builder config. `@omakase/storage` keeps a Node-agnostic surface so its own tests run under plain Node + Vitest (better-sqlite3 also works under Node directly).

## 5. Storage design

### 5.1 `.omks/` directory (git-friendly, human/agent-authored — the source of truth for authored content)

```
.omks/
├── workspace.json        # { id, name, createdAt, settings, projectRoots[] }
├── specs/<id>.md         # first-class spec: frontmatter(id,title,phase,status,tags,createdAt) + body
├── agents/<id>.md        # agent definition: frontmatter(id,name,role,agentId,model,reasoning,tools[]) + system prompt
├── memory/
│   ├── AGENTS.md         # the briefing packet (Factory-style), injected into run prompts
│   ├── wiki.md           # curated knowledge (rendered from WikiEntry; editable)
│   └── rules/*.md        # additional rule files
├── commands/<name>.md    # custom slash commands ($ARGUMENTS expansion)
├── workflows/<id>.ts     # dynamic workflow scripts (agent()/phase()/parallel()/checkpoint())
├── omks.db               # SQLite — see 5.2 (gitignored via generated .omks/.gitignore)
└── .gitignore            # ignores omks.db*, tmp
```

Authored files are markdown-with-frontmatter so they are greppable, diffable, and reviewable in PRs. `specs/`, `agents/`, `memory/`, `commands/`, `workflows/` are the left-nav "lists". The `WikiEntry`/`KnowledgeEvent` machine data lives in SQLite; `memory/wiki.md` is a rendered, user-editable projection that the app keeps in sync.

### 5.2 SQLite (`.omks/omks.db`, WAL, gitignored — high-volume, machine-written, queryable)

A thin typed repository layer over `better-sqlite3` (no heavy ORM). A versioned migration runner (`PRAGMA user_version`) applies ordered SQL migrations. The `RunRecord` is decomposed on `save()` and reassembled on `load()` so `RunStore` semantics are preserved while the event stream becomes append-only (cheap checkpoints + live tailing).

Tables (initial migration):

- `runs` — scalar fields (id, session_id, owner, mode, status, summary, spent_tokens, spent_cost_usd, checkpoint_seq, last_control_seq, created_at, updated_at, heartbeat_at) + JSON columns for current snapshots (request, route_decision, plan, acceptance, iterations, risk_gates, workflow, inbox).
- `run_events` — append-only `OrchestratorEvent` log: (id INTEGER PK, run_id, seq, type, payload_json, created_at), indexed by (run_id, seq). The high-volume stream; powers live tailing and replay.
- `tasks` + `task_dependencies` — projected task DAG for cross-run querying.
- `acceptance_criteria`, `iterations`, `risk_gates`, `reports`, `inbox_items` — projected per-run child tables.
- `knowledge_events` — append-only agent knowledge log (fact/decision/risk/progress/report/synthesis).
- `wiki_entries` — curated knowledge (mirrors `memory/wiki.md`).
- `workflows` + `workflow_phases` + `workflow_agents` + `workflow_checkpoints` — dynamic workflow execution traces.
- `codegraph_nodes` (+ edges) — structural snapshot, or kept as a JSON blob column if simpler; decision deferred to implementation but must round-trip `CodeGraphSnapshot`.

`save(record)` is transactional: upsert `runs`, append only new `run_events` (seq > stored max), upsert child projections. `load(id)` rebuilds a `RunRecord` from the `runs` row's JSON snapshots (events fetched lazily / on demand for the cockpit).

### 5.3 Global registry (app-level, outside any workspace)

At Electron `userData` (e.g. `~/Library/Application Support/Omakase/`): a small SQLite `registry.db` (or JSON) holding the list of known workspaces (path, name, lastOpened, pinned, order), app settings (theme, default autonomy, default agents), and a cache of detected "open with" apps. Mirrors DevDock's `~/.config/devdock/config.json` role.

### 5.4 Migration from `.omakase/`

On opening a folder that has a legacy `.omakase/` but no `.omks/`, offer a one-shot import: read existing `RunRecord` JSON / sessions / wiki and write them into the new `.omks/` + SQLite. Non-destructive (leaves `.omakase/` in place).

## 6. Domain & loop model

A **Run** is one execution of a loop over the workspace. `Run.mode` selects the loop:

1. **Spec mode** (Factory spec-mode / GitHub spec-kit). idea → generate spec (acceptance criteria + implementation plan + test strategy) → **approval dialog that also picks the autonomy level** → execute plan → verify against acceptance criteria → iterate until pass or budget. Read-only until approval. Built on the existing `SpecWorkflow` (`idea→spec→acceptance→test-plan→tasks→done`).
2. **Mission mode** (Factory Missions + Ralph loop, done right). Long-horizon. The orchestrator decomposes a spec into features → milestones. For each feature it spawns a **fresh-context worker** (writes tests first, implements, self-checks) → an **independent validator** evaluates for correctness/completeness (judges only; does not fix) → validator emits "fix features" handed back to the orchestrator → loop until milestone validation passes. Resumable, checkpointed, runs for hours/days. Built on the `Supervisor` + the orchestrator replan loop + a new `validator` role.
3. **Workflow mode** (Anthropic dynamic workflows). A user-authored or agent-generated `.omks/workflows/<id>.ts` script using `agent()/phase()/parallel()/pipeline()/checkpoint()` for deterministic orchestration. Built on the existing dynamic-workflow executor.
4. **Task / Chat mode** (droid-exec-equivalent). A one-shot or conversational run on the workspace. The existing default run path.

**Autonomy dial (Off / Low / Medium / High).** At our layer this governs how far a loop proceeds without human confirmation: auto-approve plans, auto-proceed through risk gates, auto-commit, auto-merge. Mapped onto the existing `RiskGate` + `ControlCommand` mechanism — a risk above the current level opens a gate (pauses for the user); at or below, it auto-proceeds. Raising autonomy removes approval prompts, never reduces visibility (the event stream is always shown). Plus a command **allowlist / denylist / blocklist** (Factory's three-list) for any shell the agents are permitted to run on the user's behalf. Org-style `maxAutonomy` clamp is a setting.

**Control.** pause / stop / queue-a-steering-message (delivered at the next turn boundary, does not interrupt in-flight work) / rewind (restore to an earlier checkpoint). All via the existing `ControlCommand` plane (`stop|pause|resume|input|answer-gate|edit-criteria`), extended minimally as needed.

**Memory / context.** `.omks/memory/AGENTS.md` injected into run prompts; rolling session summary for context compaction (exists); workers get fresh context (sub-agent isolation); the wiki + knowledge events are durable memory synthesized into wiki pages (exists).

## 7. IPC surface (`window.omakase`)

Typed bridge, channel-named like DevDock's `api.ts`. Grouped methods (invoke) + event subscriptions (`on*`). Initial surface:

- `workspaces`: list, open(path), create(path,name), close, remove, reorder, setPinned, importLegacy(path)
- `specs`: list, get(id), create, save(id, content), delete, generateFromIdea(idea) → run
- `runs`: list(filter), get(id), start({mode, specId?, prompt?, autonomy, agents?}), events(id, sinceSeq), control(id, command), delete, runInBackground(id), attach(id)
- `agents`: listDefs (custom from .omks + built-in detected), get, save, delete, detectInstalled (daemon detection)
- `memory`: readAgentsMd, writeAgentsMd, readWiki, writeWiki, listRules, knowledgeEvents(filter)
- `workflows`: list, get, save, delete, run(id)
- `projects` (Dev): scan(workspaceId), scripts.{start,stop,restart,runInTerminal}, ports.{who,kill}, env.{read,write}, git.status, apps.{list,openWith}
- `terminal`: write, resize, getBuffer, clear
- `settings`: get, set
- events: `onRunEvent`, `onRunStatus`, `onTerminalData`, `onScriptStatus`, `onPortConflict`, `onGitStatus`, `onProjectUpdated`, `onWorkspaceUpdated`

Renderer state is a Zustand store (DevDock pattern) that subscribes to these events and updates slices.

## 8. Information architecture & design

**Shell.** Left sidebar + resizable right detail pane (react-resizable-panels), collapsible sidebar.

- **Left sidebar.** Workspace switcher pinned at top (list of `.omks` workspaces: add via folder picker, drag-drop folder, search, pin, reorder — DevDock ProjectRow parity). Below it, sectioned nav for the active workspace: **Runs · Specs · Agents · Memory · Workflows · Dev**. Running items carry a status dot (Factory orange for running).
- **Right detail pane**, contextual to the selected item:
  - **Run → the cockpit.** Single-column live stream (Factory-style: `Verb target → ↳ result (+x/−y)`, collapsible step groups with chevrons, `n/m` plan checklist). Pinned bottom control bar: autonomy dial, active model, composer (queue a steering message), pause/stop/rewind. Secondary tabs: Plan (task DAG), Acceptance, Reports, Knowledge, Diffs.
  - **Spec → editor.** Markdown editor with the structured sections; "generate from idea" and "approve & run" (opens the autonomy dialog).
  - **Agent → editor.** Frontmatter form (role/model/reasoning/tools) + system-prompt markdown.
  - **Memory → editor + browser.** AGENTS.md / wiki / rules editing; knowledge-event browser.
  - **Workflow → editor.** Monaco script editor + run.
  - **Dev → workbench.** DevDock-style scripts list (play/stop + status dots + elapsed), xterm.js terminal tabs, ports panel (lsof / kill), env editor, git status, "Open with" (VS Code / Cursor / …).
- **Top bar.** Workspace name, global run status, default autonomy, ⌘K command palette, theme toggle, settings.

**Design language.** DevDock's OKLch neutral palette + a single warm accent (rust/orange, Factory-style) for active/running. Status dots: running = green/orange, building = amber, idle = gray, failed = red. 13px base; Geist Variable (sans) + JetBrains Mono Variable (mono). Tailwind v4 (`@theme` tokens in `globals.css`, no JS config) + shadcn/ui + lucide-react. Dark + light themes. Frameless window with native traffic lights (macOS), like DevDock.

## 9. Tech stack

Electron 42 · electron-vite 5 · electron-builder 26 (dist) · React 19 · Zustand 5 · Tailwind CSS v4 (`@tailwindcss/vite`) · shadcn/ui (Radix) · lucide-react · react-resizable-panels · @dnd-kit · xterm.js (+ fit/search/web-links addons) · node-pty · better-sqlite3 · TypeScript strict · Vitest (unit) + a smoke/e2e harness for the app. CLI keeps headless `run`/`agents`/`serve`; TUI (`@opentui/*`, `react`, `tests-bun`, `test:tui`) removed.

## 10. TUI removal

- Delete the TUI surface from `@omakase/cli`: `src/tui*`, any `tui-otui`, `composer-parse`, `tests-bun/`, `test:tui` script, and the `@opentui/core` / `@opentui/react` / `react` deps + `@types/bun`.
- Keep pure, reusable logic (`fuzzy.ts`, `composer.ts`, `render.ts` formatting, `run-client.ts`, `daemon-control.ts`, `serve.ts`) — used by the headless CLI and/or ported into the app.
- Remove the inlined-HTML read-only server (`read-only-server.ts`); the Electron app supersedes it. Keep the JSON-shaped accessors if cheaply reusable by the app, else delete.
- The `omakase` bin remains: `agents`, `run`, `serve` (headless). `tui` command removed.

## 11. Testing strategy

- `@omakase/storage`: Vitest unit tests against a temp-dir SQLite DB + temp `.omks/` — round-trip every `RunRecord`/`Session`/knowledge type, migration runner, atomic-write/crash safety, WAL multi-reader. Use the existing in-memory fakes from core to generate records.
- `@omakase/core` extensions: unit tests for the new validator role, autonomy gating, mission decomposition, using the existing fake `Transport` + scripted agents (no real models).
- `apps/desktop`: pure renderer logic (store reducers, event projection, fuzzy, composer) unit-tested under Vitest; a headless main-process harness test that boots `WorkspaceHost` with a fake transport and asserts the IPC event stream; a smoke test that launches the built app.
- Keep `pnpm -r typecheck && pnpm -r build && pnpm -r test` green at every phase boundary. Each fixed review finding gets a regression test (project quality bar).

## 12. Phases & acceptance criteria

Each phase ends with: code complete, `typecheck`+`build`+`test` green, an adversarial review round (subsystem finders → multi-lens verification → fix confirmed findings + regression test), and a commit. Reported at boundaries; the build does not block on the user.

1. **Foundation.** `apps/*` in workspace; `@omakase/storage` (SQLite schema + migrations + `SqliteRunStore`/`SqliteSessionStore` + knowledge repos + `.omks` file readers/writers + global registry); core wired to the new stores behind its existing interfaces; legacy `.omakase/` importer. TUI removed from CLI; CLI uses the new storage. *Accept:* storage unit tests pass; CLI `run --offline` persists to `.omks` + `omks.db`; full suite green.
2. **Electron shell.** `apps/desktop` scaffold (electron-vite, main/preload/renderer, frameless window); design system (`globals.css` tokens, theme toggle, shadcn baseline); workspace registry + switcher + create/open/import; left-nav skeleton; ⌘K palette shell. *Accept:* app boots, creates/opens a `.omks` workspace, persists registry, switches workspaces, light/dark themes.
3. **Dev workbench.** ProjectScanner, ProcessManager (node-pty), PortService, AppLauncher, GitService, FileWatcher + IPC; Dev UI: scripts (start/stop/restart + status), terminals (xterm), ports (kill), env editor, git status, "open with". *Accept:* scan a real project, start/stop a long-running script with live terminal output, detect+kill a port, open folder in an editor.
4. **Agent cockpit.** Runs list + live single-column cockpit fed by `OrchestratorEvent` over IPC; Specs (editor + spec-mode loop incl. generate-from-idea + approval dialog); Agents editor; Memory editor + knowledge browser; Workflows editor + run; autonomy dial + control bar (pause/stop/steer/rewind) + risk-gate dialogs. *Accept:* author a spec, run it in spec mode against a fake/real agent, watch the live stream, pause/steer/stop, see acceptance + reports update, persisted to `.omks`.
5. **Loops & Missions.** Mission mode (orchestrator/worker/validator) in core + UI; detached-daemon background handoff + reattach on reopen; resume of interrupted runs; budget/iteration caps surfaced. *Accept:* start a mission, close the app, confirm the detached daemon continues, reopen and reattach to the live stream; resume an interrupted run.
6. **Polish & verify.** Cross-cutting adversarial review rounds; accessibility/keyboard pass; empty/error states; electron-builder packaging (dmg) + `pnpm` scripts; README + docs; final green suite. *Accept:* packaged app launches; docs describe install/use; all tests green; review findings resolved with regression tests.

## 13. Risks & mitigations

- **Native modules under Electron ABI** (better-sqlite3, node-pty): pin versions known-good for Electron 42; configure `@electron/rebuild`; keep storage usable under plain Node for tests.
- **Two writers on one SQLite DB** (app + daemon): WAL + strict single-writer-per-run ownership; never let both own the same run; the non-owner is read-only/tailing.
- **Engine API drift:** treat `@omakase/core`/`@omakase/daemon` public types as contracts; extend additively; cover extensions with the existing fake-transport tests.
- **Scope:** phased delivery with green gates; YAGNI on non-goals; the cockpit's secondary tabs can land incrementally within phase 4 without blocking the core stream.
