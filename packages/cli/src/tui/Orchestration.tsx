/**
 * The orchestration sidebar: the focused run's plan (phases + tasks) and the
 * agents working it (token counts). Pure presentation over a RunView; expanded
 * by default, collapsible from the App.
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { RunView, TaskView } from '../view-model.js';

const STATUS_GLYPH: Record<string, string> = {
  succeeded: '✓',
  running: '▸',
  failed: '✗',
  cancelled: '⊘',
  blocked: '◌',
  pending: '◷',
};

interface AgentRow {
  label: string;
  tokens: number;
  active: boolean;
}

function agentRows(tasks: TaskView[]): AgentRow[] {
  const byLabel = new Map<string, AgentRow>();
  for (const t of tasks) {
    const label = t.agentLabel ?? t.agentId ?? 'unassigned';
    const row = byLabel.get(label) ?? { label, tokens: 0, active: false };
    row.tokens += t.tokens;
    row.active = row.active || t.status === 'running';
    byLabel.set(label, row);
  }
  return [...byLabel.values()];
}

export function Orchestration(props: {
  view: RunView;
  focused: boolean;
  expanded: boolean;
}): React.ReactElement {
  const { view, focused, expanded } = props;
  if (!expanded) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text dimColor>▸ run ({view.activeAgents} agents) — [o] expand</Text>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
      minWidth={26}
    >
      <Text bold>run ▸ {view.activeAgents} agents</Text>
      <Text bold>Plan</Text>
      {view.phases.length === 0 ? (
        <Text dimColor> no plan yet</Text>
      ) : (
        view.phases.map((p) => (
          <Text key={p.stage}>
            {' '}
            {p.done === p.total ? '✓' : '▸'} {p.stage} {p.done}/{p.total}
          </Text>
        ))
      )}
      <Text bold>Tasks</Text>
      {view.tasks.slice(0, 12).map((t) => (
        <Text key={t.id}>
          {' '}
          {STATUS_GLYPH[t.status] ?? '·'} {t.title}
        </Text>
      ))}
      <Text bold>Agents</Text>
      {agentRows(view.tasks).map((a) => (
        <Text key={a.label}>
          {' '}
          {a.active ? '●' : '○'} {a.label} {a.tokens} tok
        </Text>
      ))}
    </Box>
  );
}
