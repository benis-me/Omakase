/**
 * Plain-text rendering helpers shared by the non-interactive CLI commands.
 * (The TUI renders the same data with Ink instead.)
 */
import type { DetectedAgent } from '@omakase/daemon';
import type { RunView } from './view-model.js';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function isRunnableAgent(agent: DetectedAgent): boolean {
  return agent.available && agent.authStatus !== 'missing';
}

export function formatAgentsTable(agents: DetectedAgent[]): string {
  const rows = agents.map((a) => ({
    id: a.id,
    name: a.name,
    status: isRunnableAgent(a) ? 'runnable' : a.available ? 'auth-missing' : 'absent',
    version: a.version ?? '—',
    auth: a.authStatus,
    models: `${a.models.length} (${a.modelsSource})`,
  }));
  const headers = { id: 'ID', name: 'NAME', status: 'STATUS', version: 'VERSION', auth: 'AUTH', models: 'MODELS' };
  const cols = ['id', 'name', 'status', 'version', 'auth', 'models'] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => String(r[c]).length))]),
  ) as Record<(typeof cols)[number], number>;

  const lines: string[] = [];
  lines.push(cols.map((c) => pad(headers[c], widths[c])).join('  '));
  lines.push(cols.map((c) => '─'.repeat(widths[c])).join('  '));
  for (const r of rows) {
    lines.push(cols.map((c) => pad(String(r[c]), widths[c])).join('  '));
  }
  const availableCount = agents.filter(isRunnableAgent).length;
  lines.push('');
  lines.push(`${availableCount}/${agents.length} agents runnable`);
  // Surface why a pinned-but-unavailable agent is absent (e.g. a bad binEnvVar
  // override), so the operator isn't left guessing.
  const reasons = agents.filter((a) => !a.available && a.unavailableReason);
  if (reasons.length > 0) {
    lines.push('');
    for (const a of reasons) lines.push(`! ${a.id}: ${a.unavailableReason}`);
  }
  return lines.join('\n');
}

export function formatRunSummary(view: RunView): string {
  const lines: string[] = [];
  lines.push(`Run ${view.runId ?? '(none)'} — ${view.status}`);
  if (view.route) lines.push(`Route: ${view.route.kind} (${view.route.reason})`);
  if (view.tasks.length > 0) {
    lines.push('Tasks:');
    for (const t of view.tasks) lines.push(`  [${t.status}] (${t.role}) ${t.title}`);
  }
  if (view.codegraphStats) {
    const stats = view.codegraphStats;
    lines.push(
      `Knowledge: ${view.wikiEntries} wiki entries, ${stats.files} files, ${stats.internalEdges}/${stats.externalEdges} edges, ${stats.symbols} symbols, ${stats.cycles} cycles`,
    );
  } else {
    lines.push(`Knowledge: ${view.wikiEntries} wiki entries${view.codegraphFiles != null ? `, ${view.codegraphFiles} files` : ''}`);
  }
  if (view.summary) lines.push(view.summary);
  return lines.join('\n');
}
