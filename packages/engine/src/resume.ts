// Resume support: rebuild the cache of already-completed agent results by
// replaying the event log, so a re-executed workflow skips finished work.

import type { RunId, Store } from '@omakase/core';
import type { AgentResult } from './workflow-types.ts';

export interface ResumeState {
  cache: Map<string, AgentResult>;
  answers: Map<string, string>;
  spentAgents: number;
  tokens: number;
  costUsd: number;
  lastSeq: number;
}

export function buildResumeState(store: Store, runId: RunId): ResumeState {
  const events = store.getEvents(runId);
  const providerByCall = new Map<string, string>();
  const cache = new Map<string, AgentResult>();
  const answers = new Map<string, string>();
  let spentAgents = 0;
  let tokens = 0;
  let costUsd = 0;
  let lastSeq = 0;

  for (const e of events) {
    lastSeq = e.seq;
    if (e.type === 'user:answered') {
      answers.set(e.payload.stepKey, e.payload.answer);
    } else if (e.type === 'agent:started') {
      const p = e.payload;
      providerByCall.set(p.callId, p.provider);
    } else if (e.type === 'agent:completed') {
      const p = e.payload;
      spentAgents += 1;
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
