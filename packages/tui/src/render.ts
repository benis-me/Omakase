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

const SLOT_GLYPHS = ['❶', '❷', '❸', '❹', '❺', '❻', '❼', '❽', '❾', '❿'];

/**
 * Flatten the event log into styled lines (2-space indent per level), newest
 * last. Agents run concurrently, so their lines interleave — once a run has
 * gone parallel each agent line carries a slot marker (❶❷❸…) so you can tell
 * which agent is doing what.
 */
export function eventLines(events: AnyRunEvent[]): Line[] {
  const out: Line[] = [];
  const slot = new Map<string, number>();
  const active = new Set<string>();
  let everConcurrent = false;

  const assign = (callId: string): void => {
    const used = new Set(slot.values());
    let n = 1;
    while (used.has(n)) n++;
    slot.set(callId, n);
    active.add(callId);
    if (active.size > 1) everConcurrent = true;
  };
  const release = (callId: string): void => {
    active.delete(callId);
    slot.delete(callId);
  };
  const tag = (callId: string): string => {
    if (!everConcurrent) return '';
    const n = slot.get(callId);
    return n ? `${SLOT_GLYPHS[n - 1] ?? `#${n}`} ` : '';
  };

  for (const e of events) {
    if (e.type === 'agent:started') assign(e.payload.callId);
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
        out.push({ text: `${tag(e.payload.callId)}${e.payload.provider} › ${e.payload.title}`, color: theme.info, indent: 1 });
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
        if (e.payload.report.kind === 'final')
          out.push({ text: `✓ ${e.payload.report.title}: ${short(e.payload.report.summary, 120)}`, color: theme.ok });
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
    if (e.type === 'agent:completed' || e.type === 'agent:failed') release(e.payload.callId);
  }
  return out;
}
