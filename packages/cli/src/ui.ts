// Terminal output helpers: ANSI colors, symbols, and event rendering for the
// headless `omks run` stream. No dependencies.

import type { AnyRunEvent } from '@omakase/core';

// FORCE_COLOR lets piped/captured output keep its colours (CI logs, demos).
const useColor = (Boolean(process.stdout.isTTY) || Boolean(process.env.FORCE_COLOR)) && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  italic: (s: string) => wrap('3', s),
  red: (s: string) => wrap('31', s),
  green: (s: string) => wrap('32', s),
  yellow: (s: string) => wrap('33', s),
  blue: (s: string) => wrap('34', s),
  magenta: (s: string) => wrap('35', s),
  cyan: (s: string) => wrap('36', s),
  gray: (s: string) => wrap('90', s),
};

export const sym = {
  ok: c.green('✓'),
  fail: c.red('✗'),
  arrow: c.cyan('❯'),
  dot: c.dim('·'),
  bullet: c.dim('•'),
  gear: '⚙',
  spinnerFrames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

export function print(line = ''): void {
  process.stdout.write(line + '\n');
}

export function printErr(line = ''): void {
  process.stderr.write(line + '\n');
}

export function banner(): string {
  return c.bold(c.magenta('omakase')) + c.dim(' — orchestrate your agents');
}

/** Agents already have an identity — show it, don't invent one. */
export function agentTag(callId: string): string {
  return callId.replace(/^agt_/, '');
}

/**
 * A stateful renderer for one run's stream. Workflows run agents concurrently,
 * so their activity/result lines interleave. Each agent's line carries its real
 * call id (the same id in the event log, the JSONL journal and `--json`, so you
 * can grep for it). The id anchors every `agent:started` line; the child lines
 * only carry it once a run has actually gone parallel, so sequential runs stay
 * quiet.
 */
export function createEventRenderer(): (e: AnyRunEvent) => string | null {
  const active = new Set<string>();
  let everConcurrent = false;

  const tag = (callId: string, always = false): string =>
    always || everConcurrent ? c.dim(agentTag(callId)) + ' ' : '';

  return (e: AnyRunEvent): string | null => {
    if (e.type === 'agent:started') {
      active.add(e.payload.callId);
      if (active.size > 1) everConcurrent = true;
    }
    const line = renderEventWith(e, tag);
    if (e.type === 'agent:completed' || e.type === 'agent:failed') active.delete(e.payload.callId);
    return line;
  };
}

/** Render one run event as a compact terminal line. Returns null to skip. */
export function renderEvent(e: AnyRunEvent): string | null {
  return renderEventWith(e, () => '');
}

function renderEventWith(e: AnyRunEvent, tag: (callId: string, always?: boolean) => string): string | null {
  switch (e.type) {
    case 'run:started':
      return `${sym.arrow} ${c.bold('Goal')} ${c.dim('·')} ${c.cyan(e.payload.workflow)}\n  ${e.payload.goal.text}`;
    case 'run:resumed':
      return c.dim(`↻ resumed from seq ${e.payload.fromSeq}`);
    case 'phase:started':
      return `\n${c.bold(c.blue('▸ ' + e.payload.name))}`;
    case 'phase:ended':
      return null;
    case 'agent:started':
      return `  ${tag(e.payload.callId, true)}${c.gray(e.payload.provider)} ${c.dim('›')} ${e.payload.title}`;
    case 'agent:activity': {
      const a = e.payload.activity;
      const mark = a.kind === 'tool' ? c.yellow('⚙') : a.kind === 'reasoning' ? c.magenta('✱') : c.dim('·');
      return `      ${tag(e.payload.callId)}${mark} ${c.dim(a.summary)}`;
    }
    case 'agent:completed': {
      const badge = e.payload.status === 'ok' ? sym.ok : sym.fail;
      const cost = e.payload.costUsd > 0 ? c.dim(` $${e.payload.costUsd.toFixed(4)}`) : '';
      return `    ${tag(e.payload.callId)}${badge} ${c.dim(short(e.payload.text))}${cost}`;
    }
    case 'agent:retry':
      return c.yellow(`      ${tag(e.payload.callId)}↻ retry ${e.payload.attempt} (${e.payload.delayMs}ms)`);
    case 'harness:switched':
      return c.yellow(`    ↪ switched ${e.payload.from} → ${e.payload.to}`);
    case 'user:asked':
      return `  ${c.magenta('?')} ${c.bold(e.payload.question)}${e.payload.options.length ? c.dim(` [${e.payload.options.join('/')}]`) : ''}`;
    case 'user:answered':
      return c.dim(`  ↳ ${e.payload.answer}`);
    case 'agent:failed':
      return `    ${tag(e.payload.callId)}${sym.fail} ${c.red(short(e.payload.error))}`;
    case 'goal:evaluated': {
      const v = e.payload.verdict === 'met' ? c.green('MET') : e.payload.verdict === 'unmet' ? c.yellow('UNMET') : c.dim('—');
      const gaps = e.payload.gaps.length ? c.dim(` · ${e.payload.gaps.length} gap(s)`) : '';
      return `  ${c.dim('goal')} ${v}${gaps}`;
    }
    case 'log':
      return c.dim(`  ${e.payload.message}`);
    case 'report':
      return e.payload.report.kind === 'final'
        ? `\n${sym.ok} ${c.bold(e.payload.report.title)}\n  ${e.payload.report.summary}`
        : null;
    case 'wiki:updated':
      return c.dim(`  📓 wiki: ${e.payload.title}`);
    case 'run:ended': {
      const badge = e.payload.status === 'succeeded' ? sym.ok : e.payload.status === 'cancelled' ? c.yellow('◼') : sym.fail;
      return `\n${badge} ${c.bold(e.payload.status)} ${c.dim('·')} ${e.payload.summary ?? ''}`;
    }
    default:
      return null;
  }
}

function short(s: string, n = 100): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine;
}

/** Simple spinner for long operations. Returns a stop() function. */
export function spinner(label: string): () => void {
  if (!process.stdout.isTTY) {
    process.stdout.write(label + '\n');
    return () => {};
  }
  let i = 0;
  const timer = setInterval(() => {
    const frame = sym.spinnerFrames[i++ % sym.spinnerFrames.length]!;
    process.stdout.write(`\r${c.cyan(frame)} ${label}`);
  }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r\x1b[2K');
  };
}
