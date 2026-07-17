// Resume support: rebuild the cache of already-completed agent results by
// replaying the event log, so a re-executed workflow skips finished work.

import type { RunId, RunEventType, Store } from '@omakase/core';
import type { AgentResult } from './workflow-types.ts';

// The only event types resume reads. A busy run's log is dominated by
// agent:activity and log entries this replay never touches, so the store fetches
// just these three rather than parsing the whole log to throw most of it away.
const RESUME_TYPES: readonly RunEventType[] = ['user:answered', 'agent:started', 'agent:completed'];

export interface ResumeState {
  cache: Map<string, AgentResult>;
  answers: Map<string, string>;
  spentAgents: number;
  tokens: number;
  costUsd: number;
  lastSeq: number;
}

export function buildResumeState(store: Store, runId: RunId): ResumeState {
  const events = store.getEvents(runId, 0, RESUME_TYPES);
  const providerByCall = new Map<string, string>();
  const cache = new Map<string, AgentResult>();
  const answers = new Map<string, string>();
  let spentAgents = 0;
  let tokens = 0;
  let costUsd = 0;
  // The true high-water seq, kept off the filtered replay: the RunRecord already
  // tracks it, so read it there rather than the last matching event's seq.
  const lastSeq = store.getRun(runId)?.lastSeq ?? 0;

  for (const e of events) {
    if (e.type === 'user:answered') {
      answers.set(e.payload.stepKey, e.payload.answer);
    } else if (e.type === 'agent:started') {
      const p = e.payload;
      // One agent:started per call that charged the budget — the no-provider,
      // aborted and budget-denied paths emit agent:failed without ever charging.
      // Counting completions instead would refund every failed agent's slot and
      // let each resume spend past the cap the user set.
      if (!providerByCall.has(p.callId)) spentAgents += 1;
      providerByCall.set(p.callId, p.provider);
    } else if (e.type === 'agent:completed') {
      const p = e.payload;
      tokens += p.tokens;
      costUsd += p.costUsd;
      cache.set(p.stepKey, {
        text: p.text,
        status: p.status === 'ok' ? 'ok' : 'error',
        sessionId: p.providerSessionId,
        provider: providerByCall.get(p.callId) ?? 'unknown',
        tokens: p.tokens,
        costUsd: p.costUsd,
      });
    }
  }
  return { cache, answers, spentAgents, tokens, costUsd, lastSeq };
}
