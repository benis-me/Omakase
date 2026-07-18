// The stall advisor: when the goal-loop stops making progress, ask a second
// opinion before giving up.
//
// The loop's stall check is a blunt instrument — two rounds closing on the same
// unmet gaps means the fix agents are circling, and the run was simply stopped.
// Stopping is still the right ending, but it is a poor *next move*: the run has
// a full event log explaining how it got stuck, and nothing was reading it. This
// hands that evidence to one bounded agent and lets it say what to try instead,
// which the next round puts in front of every agent.
//
// It is deliberately meek. One consult per run, no retry, a wall-clock cap, and
// a parse that cannot throw — an advisor that misbehaves must cost a round's
// delay at most, never the run.

import { extractJson, type AnyRunEvent } from '@omakase/core';
import type { Harness } from './harness.ts';

/** What the advisor is told, and what the run can show it. */
export interface StallSituation {
  goalText: string;
  gaps: string[];
  round: number;
  events: AnyRunEvent[];
}

export interface Advice {
  headline: string;
  body: string;
}

export interface ConsultOptions {
  harness: Harness;
  provider: string;
  model?: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Report the advisor's own spend — it is not free and must be accounted. */
  onSpend?: (tokens: number, costUsd: number) => void;
}

/** How much of the log the advisor sees. Enough to spot a pattern, bounded so a
 *  long run cannot blow up the prompt. */
const EVENT_TAIL = 40;
const TEXT_CAP = 600;
const HEADLINE_CAP = 160;
const BODY_CAP = 1200;
export const ADVISOR_TIMEOUT_MS = 90_000;

function clip(s: string, n: number): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) : one;
}

/**
 * Render the tail of the log as the story of how the run got stuck: what each
 * agent tried, what it said, and what the verifier kept rejecting.
 */
export function describeSituation(s: StallSituation): string {
  const lines: string[] = [];
  for (const e of s.events.slice(-EVENT_TAIL)) {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'agent:started':
        lines.push(`- dispatched ${String(p.provider)}: ${String(p.title)}`);
        break;
      case 'agent:completed':
        lines.push(`  → ${clip(String(p.text ?? ''), TEXT_CAP)}`);
        break;
      case 'agent:failed':
        lines.push(`  ✗ failed: ${clip(String(p.error ?? ''), 200)}`);
        break;
      case 'goal:evaluated':
        lines.push(`- verdict: ${String(p.verdict)} — ${clip(String(p.note ?? ''), 200)}`);
        break;
      case 'log':
        lines.push(`- ${clip(String(p.message ?? ''), 200)}`);
        break;
    }
  }
  return lines.join('\n');
}

function buildPrompt(s: StallSituation): string {
  return [
    'You are advising an autonomous multi-agent run that has stopped making progress.',
    `It has now finished round ${s.round + 1} closing on exactly the same unmet criteria as the round before,`,
    'which means the agents are repeating an approach that does not work.',
    '',
    `GOAL: ${s.goalText}`,
    '',
    'STILL UNMET:',
    ...s.gaps.map((g) => `- ${g}`),
    '',
    'WHAT HAS BEEN TRIED (tail of the run log):',
    describeSituation(s),
    '',
    'Say what to do differently. Name the likely reason the attempts keep failing and one',
    'concrete, specific change of approach — not a restatement of the goal, and not advice',
    'to "try again" or "check carefully". If the evidence suggests the criteria themselves',
    'are unsatisfiable as written, say that instead.',
    '',
    'Reply with a single line of JSON: {"headline":"...","advice":"..."}',
    'Do not modify any files; you are advising, not fixing.',
  ].join('\n');
}

/**
 * Read an advisor's reply. Structured JSON is preferred, but a model that
 * answers in prose still has something useful to say, so prose becomes the
 * advice verbatim. Returns null only when there is genuinely nothing.
 */
export function parseAdvice(text: string): Advice | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;

  const obj = extractJson<{ headline?: unknown; advice?: unknown; body?: unknown }>(raw);
  if (obj && typeof obj === 'object') {
    const headline = typeof obj.headline === 'string' ? obj.headline : '';
    const bodyField = typeof obj.advice === 'string' ? obj.advice : typeof obj.body === 'string' ? obj.body : '';
    if (headline || bodyField) {
      return {
        headline: clip(headline || bodyField, HEADLINE_CAP),
        body: clip(bodyField || headline, BODY_CAP),
      };
    }
  }

  // Prose fallback: the first non-empty line is the headline, the whole reply
  // is the advice.
  const first = raw.split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  return { headline: clip(first, HEADLINE_CAP), body: clip(raw, BODY_CAP) };
}

/**
 * Ask one advisor what to try next. Never throws: a failed or empty consult
 * simply yields null and the loop carries on to its own ending.
 *
 * The advisor runs without auto-approval — it is handed the evidence in its
 * prompt and has no reason to touch the workspace. That is a conservative
 * setting rather than a guarantee: the harness has no tool allow-list yet, so
 * this cannot *enforce* read-only the way a sandboxed permission mode would.
 */
export async function consultAdvisor(s: StallSituation, o: ConsultOptions): Promise<Advice | null> {
  try {
    if (o.signal?.aborted) return null;
    const res = await o.harness.runAgent({
      provider: o.provider,
      ...(o.model ? { model: o.model } : {}),
      role: 'advisor',
      title: 'Advise on the stall',
      prompt: buildPrompt(s),
      cwd: o.cwd,
      autoApprove: false,
      timeoutMs: o.timeoutMs ?? ADVISOR_TIMEOUT_MS,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    o.onSpend?.(res.tokens, res.costUsd);
    if (res.status !== 'ok') return null;
    return parseAdvice(res.text);
  } catch {
    return null;
  }
}

/** The preamble the next round's agents see, mirroring how gaps are fed back. */
export function advicePreamble(a: Advice): string {
  return [
    'ADVICE (auto-generated: the run was repeating an approach that was not working)',
    a.headline,
    a.body && a.body !== a.headline ? a.body : '',
  ]
    .filter(Boolean)
    .join('\n');
}
