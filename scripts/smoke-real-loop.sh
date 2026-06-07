#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMAKASE="${OMAKASE_BIN:-$ROOT/scripts/omakase.sh}"
OUT="${OMAKASE_SMOKE_OUT:-$(mktemp -t omakase-real-loop.XXXXXX.jsonl)}"
TIMEOUT_SECONDS="${OMAKASE_SMOKE_TIMEOUT_SECONDS:-900}"
PROMPT="${OMAKASE_SMOKE_PROMPT:-$(cat <<'PROMPT'
Omakase real-loop smoke test for this repository.

Constraints:
- Read-only. Do not edit files.
- Treat this as a complex multi-agent task.
- Planner should create concrete acceptance criteria for exactly two worker tasks: package metadata evidence and docs/source evidence.
- Do not put reporter, wiki curator, strategy-update, event-log, session-log, or .omakase persistence checks into the acceptance criteria or main task graph; the external smoke harness validates those JSON events after the run.
- Package worker must inspect only `/Users/ben/Projects/Omakase2/package.json` and make its first output line: `PACKAGE_EVIDENCE path=/Users/ben/Projects/Omakase2/package.json name=<name> packageManager=<packageManager> readOnly=true`.
- Docs worker must inspect only `/Users/ben/Projects/Omakase2/README.md` and make its first output line: `DOC_EVIDENCE path=/Users/ben/Projects/Omakase2/README.md heading=<heading> readOnly=true`.
- Reviewer should approve when both first-line evidence markers are present.
- Do not run nested omakase commands.
PROMPT
)}"

if [[ "${1:-}" == "--dry-run" ]]; then
  printf 'dry-run: would run %q run --json --cwd %q --mode normal --agent codex %q\n' "$OMAKASE" "$ROOT" "$PROMPT"
  exit 0
fi

if [[ ! -x "$OMAKASE" ]]; then
  echo "smoke-real-loop: omakase launcher is not executable: $OMAKASE" >&2
  exit 1
fi

agents_json="$("$OMAKASE" agents --json --cwd "$ROOT")"
if ! printf '%s\n' "$agents_json" | grep -Eq '"id"[[:space:]]*:[[:space:]]*"codex"'; then
  echo "smoke-real-loop: codex agent was not detected; refusing to fall back to offline/builtin" >&2
  exit 1
fi

run_pid=''
cleanup() {
  if [[ -n "$run_pid" ]] && kill -0 "$run_pid" 2>/dev/null; then
    kill "$run_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

set +e
"$OMAKASE" run --json --cwd "$ROOT" --mode normal --agent codex "$PROMPT" >"$OUT" 2>&1 &
run_pid=$!

elapsed=0
while kill -0 "$run_pid" 2>/dev/null; do
  if (( elapsed >= TIMEOUT_SECONDS )); then
    echo "smoke-real-loop: timed out after ${TIMEOUT_SECONDS}s; output kept at $OUT" >&2
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
  echo "smoke-real-loop: omakase run exited $status; output kept at $OUT" >&2
  tail -n 80 "$OUT" >&2 || true
  exit "$status"
fi

require_event() {
  local pattern="$1"
  local label="$2"
  if ! grep -Eq "$pattern" "$OUT"; then
    echo "smoke-real-loop: missing $label in $OUT" >&2
    tail -n 120 "$OUT" >&2 || true
    exit 1
  fi
}

require_event '"type":"agent-event".*"role":"planner"' 'planner agent events'
require_event '"type":"agent-event".*"role":"reporter"' 'reporter agent events'
require_event '"type":"agent-event".*"role":"wiki-curator"' 'wiki curator agent events'
require_event '"type":"strategy-updated"' 'strategy update event'
require_event '"type":"run-finished".*"status":"succeeded"' 'successful run finish'

node --input-type=module - "$OUT" <<'NODE'
import fs from 'node:fs';

const out = process.argv[2];
const events = fs
  .readFileSync(out, 'utf8')
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
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
  console.error(`smoke-real-loop: main task graph contains support sidecar task(s): ${badSidecars.map((task) => task.title).join(', ')}`);
  process.exit(1);
}
NODE

if grep -Eq '"agentId":"builtin"|"agentId":"scripted"' "$OUT"; then
  echo "smoke-real-loop: saw builtin/scripted agent in real smoke output; output kept at $OUT" >&2
  exit 1
fi

echo "smoke-real-loop: passed using real codex agent; output: $OUT"
