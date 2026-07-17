// Turn the flat event log into the structure the run view renders: an ordered
// list of phase dividers, agent blocks (each folding in its own activity + final
// result), and the loose events (logs, verdicts, questions, the ending) that
// belong between them. The agent grouping is what makes an interleaved,
// many-agent run readable instead of a wall of lines.

import type { RunEvent } from './api.ts';

export interface Activity {
  kind: string;
  summary: string;
}
export interface AgentBlock {
  kind: 'agent';
  key: string;
  callId: string;
  provider: string;
  title: string;
  activities: Activity[];
  status: 'live' | 'ok' | 'error';
  result: string; // final text or error message
  costUsd: number;
}
export interface PhaseBlock {
  kind: 'phase';
  key: string;
  name: string;
}
export interface LooseBlock {
  kind: 'loose';
  key: string;
  cls: string;
  glyph: string;
  text: string;
}
export type Block = AgentBlock | PhaseBlock | LooseBlock;

function agentTag(callId: string): string {
  return callId.replace(/^agt_/, '');
}
function trim(s: unknown, n = 220): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function buildBlocks(events: RunEvent[]): Block[] {
  const out: Block[] = [];
  const agents = new Map<string, AgentBlock>();
  const started = new Set<string>();

  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.type) {
      case 'phase:started':
        out.push({ kind: 'phase', key: `p${e.seq}`, name: p.name });
        break;
      case 'agent:started': {
        started.add(p.callId);
        const block: AgentBlock = {
          kind: 'agent',
          key: `a${e.seq}`,
          callId: p.callId,
          provider: p.provider,
          title: p.title,
          activities: [],
          status: 'live',
          result: '',
          costUsd: 0,
        };
        agents.set(p.callId, block);
        out.push(block);
        break;
      }
      case 'agent:activity': {
        const a = agents.get(p.callId);
        if (a) a.activities.push({ kind: p.activity?.kind ?? 'notice', summary: p.activity?.summary ?? '' });
        break;
      }
      case 'agent:completed': {
        const a = agents.get(p.callId);
        if (a) {
          a.status = p.status === 'ok' ? 'ok' : 'error';
          a.result = p.text ?? '';
          a.costUsd = p.costUsd ?? 0;
        }
        break;
      }
      case 'agent:retry': {
        const a = agents.get(p.callId);
        if (a) a.activities.push({ kind: 'retry', summary: `retry ${p.attempt}` });
        break;
      }
      case 'agent:failed': {
        // Steps a cancelled run had queued are turned away before they start;
        // one row each only buries the cancel that caused them.
        if (p.error === 'aborted' && !started.has(p.callId)) break;
        const a = agents.get(p.callId);
        if (a) {
          a.status = 'error';
          a.result = p.error ?? 'failed';
        } else {
          out.push({ kind: 'loose', key: `f${e.seq}`, cls: 'switched', glyph: '✗', text: trim(p.error) });
        }
        break;
      }
      case 'harness:switched':
        out.push({ kind: 'loose', key: `s${e.seq}`, cls: 'switched', glyph: '↪', text: `${p.from} → ${p.to}` });
        break;
      case 'goal:evaluated': {
        const met = p.verdict === 'met';
        const gaps = p.gaps?.length ? ` · ${p.gaps.length} gap(s)` : '';
        out.push({
          kind: 'loose',
          key: `g${e.seq}`,
          cls: met ? 'goal-met' : 'goal-unmet',
          glyph: met ? '✓' : '•',
          text: `goal ${met ? 'met' : 'unmet'}${gaps}`,
        });
        break;
      }
      case 'user:asked':
        out.push({
          kind: 'loose',
          key: `q${e.seq}`,
          cls: 'ask',
          glyph: '?',
          text: `${p.question}${p.options?.length ? ` [${p.options.join('/')}]` : ''}`,
        });
        break;
      case 'user:answered':
        out.push({ kind: 'loose', key: `an${e.seq}`, cls: 'answer', glyph: '↳', text: trim(p.answer) });
        break;
      case 'log':
        out.push({ kind: 'loose', key: `l${e.seq}`, cls: 'log', glyph: '·', text: trim(p.message) });
        break;
      case 'run:ended':
        out.push({ kind: 'loose', key: `e${e.seq}`, cls: `ended ${p.status}`, glyph: endGlyph(p.status), text: trim(p.summary) });
        break;
      // run:started / phase:ended / report / wiki:updated / run:resumed → header or noise
    }
  }
  return out;
}

function endGlyph(status: string): string {
  return status === 'succeeded' ? '✓' : status === 'cancelled' ? '◼' : '✗';
}

export { agentTag };
