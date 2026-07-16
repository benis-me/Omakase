// Theme + event → styled-line mapping for the TUI (no JSX here).
//
// "Omakase Calm": a self-painted deep-neutral canvas with one restrained teal
// accent. Painting our own background is the root fix for both legibility bugs —
// contrast is guaranteed regardless of the user's terminal theme. Contrast
// ratios (vs. canvas) were verified: fg 15:1, dim 7.3:1, faint 4.5:1,
// accent 8.8:1, border 1.7:1 (subtle but visible).

import type { AnyRunEvent } from '@omakase/core';

export const theme = {
  canvas: '#0F1115',
  panel: '#14161C',
  panelAlt: '#1B1E26',
  fg: '#E4E6EB',
  dim: '#9BA1AD',
  faint: '#757B8A',
  border: '#363B47',
  borderFocus: '#6DBFB4',
  hairline: '#2E323C',
  accent: '#6DBFB4', // teal — action / live
  accent2: '#7AA2D6', // blue — structure (phases)
  ok: '#6FCF97',
  warn: '#E5C07B',
  err: '#E06C75',
  info: '#56B6C2',
  // input
  inputBg: '#14161C',
  inputFg: '#E4E6EB',
  inputFgFocus: '#F2F4F8',
  placeholder: '#6B7180',
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

/** Agents already have an identity — show it, don't invent one. */
export function agentTag(callId: string): string {
  return callId.replace(/^agt_/, '');
}

/**
 * Flatten the event log into styled lines (2-space indent per level), newest
 * last. Agents run concurrently, so their lines interleave — each carries its
 * real call id (the same id in the journal and `--json`). The id anchors every
 * `agent:started`; child lines only carry it once the run has gone parallel, so
 * sequential runs stay quiet.
 */
export function eventLines(events: AnyRunEvent[]): Line[] {
  const out: Line[] = [];
  const active = new Set<string>();
  const started = new Set<string>();
  let everConcurrent = false;

  const tag = (callId: string, always = false): string =>
    always || everConcurrent ? `${agentTag(callId)} ` : '';

  for (const e of events) {
    if (e.type === 'agent:started') {
      started.add(e.payload.callId);
      active.add(e.payload.callId);
      if (active.size > 1) everConcurrent = true;
    }
    // A cancelled run's workflow keeps handing over the steps it had queued, and
    // each is turned away before it starts. They never ran, so one ✗ per queued
    // step only buries the cancel that caused them.
    if (e.type === 'agent:failed' && e.payload.error === 'aborted' && !started.has(e.payload.callId)) continue;
    switch (e.type) {
      case 'run:started':
        out.push({ text: `❯ ${short(e.payload.goal.text, 160)}`, color: theme.fg });
        break;
      case 'run:resumed':
        out.push({ text: '↻ resumed', color: theme.dim, indent: 1 });
        break;
      case 'phase:started':
        out.push({ text: `▸ ${e.payload.name}`, color: theme.accent2 });
        break;
      case 'agent:started':
        out.push({ text: `${tag(e.payload.callId, true)}${e.payload.provider} › ${e.payload.title}`, color: theme.info, indent: 1 });
        break;
      case 'agent:activity': {
        const a = e.payload.activity;
        const mark = a.kind === 'tool' ? '⚙' : a.kind === 'reasoning' ? '✱' : '·';
        out.push({ text: `${tag(e.payload.callId)}${mark} ${short(a.summary, 100)}`, color: theme.faint, indent: 3 });
        break;
      }
      case 'agent:completed': {
        const cost = e.payload.costUsd > 0 ? `  $${e.payload.costUsd.toFixed(4)}` : '';
        out.push({
          text: `${tag(e.payload.callId)}${e.payload.status === 'ok' ? '✓' : '✗'} ${short(e.payload.text, 120)}${cost}`,
          color: e.payload.status === 'ok' ? theme.ok : theme.err,
          indent: 2,
        });
        break;
      }
      case 'agent:retry':
        out.push({ text: `${tag(e.payload.callId)}↻ retry ${e.payload.attempt}`, color: theme.warn, indent: 3 });
        break;
      case 'harness:switched':
        out.push({ text: `↪ ${e.payload.from} → ${e.payload.to}`, color: theme.warn, indent: 2 });
        break;
      case 'agent:failed':
        out.push({ text: `${tag(e.payload.callId)}✗ ${short(e.payload.error, 100)}`, color: theme.err, indent: 2 });
        break;
      case 'user:asked':
        out.push({
          text: `? ${e.payload.question}${e.payload.options.length ? ` [${e.payload.options.join('/')}]` : ''}`,
          color: theme.accent,
          indent: 1,
        });
        break;
      case 'user:answered':
        out.push({ text: `↳ ${e.payload.answer}`, color: theme.dim, indent: 2 });
        break;
      case 'goal:evaluated': {
        const met = e.payload.verdict === 'met';
        const gaps = e.payload.gaps.length ? ` · ${e.payload.gaps.length} gap(s)` : '';
        out.push({ text: `goal ${met ? 'MET' : 'UNMET'}${gaps}`, color: met ? theme.ok : theme.warn, indent: 1 });
        break;
      }
      case 'log':
        out.push({ text: short(e.payload.message, 120), color: theme.dim, indent: 1 });
        break;
      case 'report':
        // `run:ended` summarises the workflow's final report, so showing it here
        // says the same thing twice — and a workflow that filed a rosy report
        // before it was cut short would stamp a ✓ above its own ◼ cancelled.
        break;
      case 'wiki:updated':
        out.push({ text: `📓 ${e.payload.title}`, color: theme.dim, indent: 1 });
        break;
      case 'run:ended': {
        const s = e.payload.status;
        out.push({
          text: `${s === 'succeeded' ? '✓' : s === 'cancelled' ? '◼' : '✗'} ${s} · ${short(e.payload.summary ?? '', 120)}`,
          color: s === 'succeeded' ? theme.ok : s === 'cancelled' ? theme.warn : theme.err,
        });
        break;
      }
    }
    if (e.type === 'agent:completed' || e.type === 'agent:failed') active.delete(e.payload.callId);
  }
  return out;
}
