// Theme + event → styled-line mapping for the TUI (no JSX here).

import type { AnyRunEvent } from '@omakase/core';

export const theme = {
  fg: '#e6e6e6',
  dim: '#8b8b93',
  faint: '#5c5c66',
  magenta: '#c792ea',
  cyan: '#89ddff',
  blue: '#82aaff',
  green: '#42be65',
  red: '#ff5370',
  yellow: '#ffcb6b',
  border: '#33343a',
  borderFocus: '#c792ea',
  panel: '#16171d',
};

export interface Line {
  text: string;
  color: string;
  indent?: number;
}

function short(s: string, n = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** Flatten the event log into styled lines, newest last. */
export function eventLines(events: AnyRunEvent[]): Line[] {
  const out: Line[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'run:started':
        out.push({ text: `❯ ${e.payload.goal.text}`, color: theme.fg });
        break;
      case 'run:resumed':
        out.push({ text: `↻ resumed`, color: theme.dim });
        break;
      case 'phase:started':
        out.push({ text: `▸ ${e.payload.name}`, color: theme.blue });
        break;
      case 'agent:started':
        out.push({ text: `${e.payload.provider} › ${e.payload.title}`, color: theme.cyan, indent: 1 });
        break;
      case 'agent:activity': {
        const a = e.payload.activity;
        const mark = a.kind === 'tool' ? '⚙' : a.kind === 'reasoning' ? '✱' : '·';
        out.push({ text: `${mark} ${short(a.summary, 100)}`, color: theme.faint, indent: 3 });
        break;
      }
      case 'agent:completed': {
        const mark = e.payload.status === 'ok' ? '✓' : '✗';
        const cost = e.payload.costUsd > 0 ? `  $${e.payload.costUsd.toFixed(4)}` : '';
        out.push({
          text: `${mark} ${short(e.payload.text, 120)}${cost}`,
          color: e.payload.status === 'ok' ? theme.green : theme.red,
          indent: 2,
        });
        break;
      }
      case 'agent:retry':
        out.push({ text: `↻ retry ${e.payload.attempt}`, color: theme.yellow, indent: 3 });
        break;
      case 'harness:switched':
        out.push({ text: `↪ ${e.payload.from} → ${e.payload.to}`, color: theme.yellow, indent: 2 });
        break;
      case 'user:asked':
        out.push({ text: `? ${e.payload.question}${e.payload.options.length ? ` [${e.payload.options.join('/')}]` : ''}`, color: theme.magenta, indent: 1 });
        break;
      case 'user:answered':
        out.push({ text: `↳ ${e.payload.answer}`, color: theme.dim, indent: 2 });
        break;
      case 'agent:failed':
        out.push({ text: `✗ ${short(e.payload.error, 100)}`, color: theme.red, indent: 2 });
        break;
      case 'goal:evaluated': {
        const v = e.payload.verdict === 'met' ? 'MET' : e.payload.verdict === 'unmet' ? 'UNMET' : '—';
        const gaps = e.payload.gaps.length ? `  ${e.payload.gaps.length} gap(s)` : '';
        out.push({ text: `goal ${v}${gaps}`, color: e.payload.verdict === 'met' ? theme.green : theme.yellow, indent: 1 });
        break;
      }
      case 'log':
        out.push({ text: short(e.payload.message, 120), color: theme.dim, indent: 1 });
        break;
      case 'report':
        if (e.payload.report.kind === 'final')
          out.push({ text: `✓ ${e.payload.report.title}: ${short(e.payload.report.summary, 120)}`, color: theme.green });
        break;
      case 'wiki:updated':
        out.push({ text: `📓 ${e.payload.title}`, color: theme.dim, indent: 1 });
        break;
      case 'run:ended':
        out.push({
          text: `${e.payload.status === 'succeeded' ? '✓' : e.payload.status === 'cancelled' ? '◼' : '✗'} ${e.payload.status} · ${short(e.payload.summary ?? '', 120)}`,
          color: e.payload.status === 'succeeded' ? theme.green : e.payload.status === 'cancelled' ? theme.yellow : theme.red,
        });
        break;
    }
  }
  return out;
}
