#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMAKASE="${OMAKASE_BIN:-$ROOT/scripts/omakase.sh}"
OUT="${OMAKASE_SMOKE_OUT:-$(mktemp -t omakase-real-normal-loop.XXXXXX.jsonl)}"
TIMEOUT_SECONDS="${OMAKASE_SMOKE_TIMEOUT_SECONDS:-900}"
PROMPT="${OMAKASE_SMOKE_PROMPT:-$(cat <<'PROMPT'
Omakase real normal-mode multi-agent smoke test for this repository.

Constraints:
- Read-only. Do not edit files.
- Treat this as a complex task that should use normal-mode multi-agent worker distribution.
- If only one authenticated real CLI is available, use multiple independent real worker instances on that CLI; do not fall back to offline/builtin/scripted agents.
- Planner should create exactly two independent worker tasks. Omakase automatically adds the reviewer task; the planner must not add review, approval, or verification tasks.
- Do not put reporter, wiki curator, strategy-update, event-log, session-log, or .omakase persistence checks into the acceptance criteria or main task graph; the external smoke harness validates those JSON events after the run.
- Package worker must inspect only `/Users/ben/Projects/Omakase2/package.json` and include this exact marker string anywhere in its worker output: `NORMAL_PACKAGE_EVIDENCE path=/Users/ben/Projects/Omakase2/package.json readOnly=true`.
- Docs worker must inspect only `/Users/ben/Projects/Omakase2/README.md` and include this exact marker string anywhere in its worker output: `NORMAL_DOC_EVIDENCE path=/Users/ben/Projects/Omakase2/README.md readOnly=true`.
- Reviewer should approve when both exact marker strings are present anywhere in worker outputs and no file edits are claimed. Do not reject because of skill/process preambles or line-boundary placement.
- Do not run nested omakase commands.
PROMPT
)}"

if [[ ! -x "$OMAKASE" ]]; then
  echo "smoke-real-normal-loop: omakase launcher is not executable: $OMAKASE" >&2
  exit 1
fi

agents_json="$("$OMAKASE" agents --json --cwd "$ROOT")"
auth_agents="$(
  AGENTS_JSON="$agents_json" node --input-type=module <<'NODE'
const agents = JSON.parse(process.env.AGENTS_JSON ?? '[]');
const ready = agents
  .filter((agent) => agent.available && agent.authStatus === 'ok' && !['builtin', 'scripted'].includes(agent.id))
  .map((agent) => agent.id);
if (ready.length < 1) {
  console.error(`need at least 1 authenticated available real agent, found ${ready.length}: ${ready.join(', ') || '(none)'}`);
  process.exit(1);
}
console.log(ready.join(','));
NODE
)"

if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'dry-run: authenticated agents: %s\n' "$auth_agents"
  printf 'dry-run: would run %q run --json --cwd %q --mode normal %q\n' "$OMAKASE" "$ROOT" "$PROMPT"
  exit 0
fi

run_pid=''
cleanup() {
  if [[ -n "$run_pid" ]] && kill -0 "$run_pid" 2>/dev/null; then
    kill "$run_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

set +e
"$OMAKASE" run --json --cwd "$ROOT" --mode normal "$PROMPT" >"$OUT" 2>&1 &
run_pid=$!

elapsed=0
while kill -0 "$run_pid" 2>/dev/null; do
  if (( elapsed >= TIMEOUT_SECONDS )); then
    echo "smoke-real-normal-loop: timed out after ${TIMEOUT_SECONDS}s; output kept at $OUT" >&2
    kill "$run_pid" 2>/dev/null || true
    wait "$run_pid" 2>/dev/null
    exit 124
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
wait "$run_pid"
status=$?
set -e
run_pid=''

if (( status != 0 )); then
  echo "smoke-real-normal-loop: omakase run exited $status; output kept at $OUT" >&2
  tail -n 80 "$OUT" >&2 || true
  exit "$status"
fi

node --input-type=module - "$OUT" <<'NODE'
import fs from 'node:fs';

const out = process.argv[2];
const lines = fs.readFileSync(out, 'utf8').split(/\n+/).filter(Boolean);
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    // Keep stderr diagnostics in the output file without making parsing brittle.
  }
}

function fail(message) {
  console.error(`smoke-real-normal-loop: ${message}; output kept at ${out}`);
  const tail = lines.slice(-120).join('\n');
  if (tail) console.error(tail);
  process.exit(1);
}

function hasEvent(predicate) {
  return events.some(predicate);
}

if (events.length === 0) fail('no JSON events parsed');
if (!hasEvent((event) => event.type === 'agent-event' && event.role === 'planner')) fail('missing planner agent events');
if (!hasEvent((event) => event.type === 'agent-event' && event.role === 'reporter')) fail('missing reporter agent events');
if (!hasEvent((event) => event.type === 'agent-event' && event.role === 'wiki-curator')) fail('missing wiki-curator agent events');
if (!hasEvent((event) => event.type === 'report-requested' && event.kind === 'planning' && event.source === 'planner')) {
  fail('missing planner report-requested event');
}
if (!hasEvent((event) => event.type === 'report-requested' && event.kind === 'review' && event.source === 'reviewer')) {
  fail('missing reviewer report-requested event');
}
if (!hasEvent((event) => event.type === 'strategy-updated')) fail('missing strategy update event');
if (!hasEvent((event) => event.type === 'run-finished' && event.status === 'succeeded')) fail('missing successful run finish');

const plannedTasks = events
  .filter((event) => event.type === 'planned')
  .flatMap((event) => event.snapshot?.tasks ?? []);
const badSidecars = plannedTasks.filter((task) => {
  const text = `${task.title ?? ''} ${task.description ?? ''}`.toLowerCase();
  const sidecar = text.includes('sidecar') || text.includes('out-of-main-graph') || text.includes('outside main graph');
  const support = text.includes('reporter') || text.includes('wiki curator') || text.includes('wiki-curator');
  return sidecar && support;
});
if (badSidecars.length > 0) {
  fail(`main task graph contains support sidecar task(s): ${badSidecars.map((task) => task.title).join(', ')}`);
}

const assigned = events.filter((event) => event.type === 'agent-assigned');
const badAgent = assigned.find((event) => ['builtin', 'scripted'].includes(event.assignment?.agentId));
if (badAgent) fail(`saw fake agent assignment: ${badAgent.assignment?.agentId}`);

const workerAssignments = assigned
  .filter((event) => event.role === 'worker' && event.taskId)
  .filter((event) => event.assignment?.agentId && !['builtin', 'scripted'].includes(event.assignment.agentId));
const workerAgents = workerAssignments.map((event) => event.assignment?.agentId).filter(Boolean);
const workerRunIds = workerAssignments.map((event) => event.agentRunId).filter(Boolean);
const distinctWorkerRuns = new Set(workerRunIds);
if (distinctWorkerRuns.size < 2) {
  const labels = workerAssignments.map((event) => event.agentLabel ?? event.assignment?.agentId).filter(Boolean);
  fail(`expected at least 2 distinct real worker run instances, saw labels: ${labels.join(', ') || '(none)'}`);
}

const deltas = events
  .filter((event) => event.type === 'agent-event' && event.role === 'worker' && event.event?.type === 'text_delta')
  .map((event) => event.event.delta ?? '')
  .join('\n');
if (!deltas.includes('NORMAL_PACKAGE_EVIDENCE')) fail('missing package evidence marker');
if (!deltas.includes('NORMAL_DOC_EVIDENCE')) fail('missing docs evidence marker');
NODE

echo "smoke-real-normal-loop: passed using real normal-mode agent pool ($auth_agents); output: $OUT"
