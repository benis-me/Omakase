// Theme + event → styled-line mapping for the TUI (no JSX here).
//
// "Omakase Calm": a self-painted deep-neutral canvas with one restrained teal
// accent. Painting our own background is the root fix for both legibility bugs —
// contrast is guaranteed regardless of the user's terminal theme. Contrast
// ratios (vs. canvas) were verified: fg 15:1, dim 7.3:1, faint 4.5:1,
// accent 8.8:1, border 1.7:1 (subtle but visible).

import { agentTag, type AnyRunEvent } from '@omakase/core';

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

/** One physical terminal row: exactly what gets painted on one line. */
export interface Row {
  text: string;
  color: string;
}

/**
 * Lay logical lines out as physical rows of a fixed width.
 *
 * A `<text>` whose content is wider than its box wraps, which silently costs
 * more rows than the caller budgeted for — the window slice then overflows the
 * panel and rows paint over each other. Deciding here how many rows each line
 * really occupies is what keeps the log legible: `wrap: false` clips a line to
 * exactly one row, `wrap: true` breaks it into as many as it needs, and either
 * way the count the caller sees is the count it gets.
 */
export function layoutRows(lines: Line[], width: number, wrap: boolean): Row[] {
  const w = Math.max(8, width);
  const rows: Row[] = [];
  // Every row is padded to the full width: the window slides a row's text under
  // a reused element, and a shorter string would otherwise leave the tail of the
  // previous one on screen.
  const push = (text: string, color: string) => rows.push({ text: text.padEnd(w), color });
  for (const ln of lines) {
    const pad = '  '.repeat(ln.indent ?? 0);
    const text = pad + ln.text;
    if (!wrap) {
      push(text.length > w ? text.slice(0, w - 1) + '…' : text, ln.color);
      continue;
    }
    if (text.length <= w) {
      push(text, ln.color);
      continue;
    }
    // Wrapped continuations keep the line's indent, so a long agent result stays
    // visually attached to the agent it came from.
    const cont = pad + '  ';
    let rest = text;
    let first = true;
    while (rest.length) {
      const room = first ? w : Math.max(8, w - cont.length);
      let cut = rest.length <= room ? rest.length : rest.lastIndexOf(' ', room);
      if (cut <= 0 || rest.length <= room) cut = Math.min(room, rest.length);
      push((first ? '' : cont) + rest.slice(0, cut).trimEnd(), ln.color);
      rest = rest.slice(cut).trimStart();
      first = false;
    }
  }
  return rows;
}

/**
 * The slice of rows a log panel should paint, given how far the reader has
 * scrolled back from the newest row. `scrollBack` is clamped to what actually
 * exists, so holding page-up past the top parks at the top, and a run that
 * grows while pinned (offset 0) keeps showing its tail.
 */
export function logWindow(total: number, height: number, scrollBack: number): { start: number; end: number; offset: number } {
  const h = Math.max(1, height);
  const maxScroll = Math.max(0, total - h);
  const offset = Math.min(Math.max(0, scrollBack), maxScroll);
  const end = total - offset;
  return { start: Math.max(0, end - h), end, offset };
}

function short(s: string, n = 200): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
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
