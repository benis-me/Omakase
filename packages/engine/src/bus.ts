// In-process event bus so live consumers (TUI/CLI) receive run events as they
// happen, in addition to the durable store. Consumers replay from the store,
// then subscribe live — this helper does replay+live without gaps.

import type { AnyRunEvent, RunId, Store } from '@omakase/core';

export type RunEventListener = (event: AnyRunEvent) => void;

export class RunBus {
  private byRun = new Map<RunId, Set<RunEventListener>>();
  private global = new Set<RunEventListener>();

  emit(event: AnyRunEvent): void {
    const set = this.byRun.get(event.runId);
    if (set) for (const l of [...set]) safe(l, event);
    for (const l of [...this.global]) safe(l, event);
  }

  on(runId: RunId, listener: RunEventListener): () => void {
    let set = this.byRun.get(runId);
    if (!set) {
      set = new Set();
      this.byRun.set(runId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  onAny(listener: RunEventListener): () => void {
    this.global.add(listener);
    return () => this.global.delete(listener);
  }
}

function safe(l: RunEventListener, e: AnyRunEvent): void {
  try {
    l(e);
  } catch {
    /* listener errors must not break the run */
  }
}

/**
 * Replay persisted events after `afterSeq`, then stream live ones. Returns an
 * unsubscribe function. Guarantees no gap and no duplicate across the handoff.
 */
export function subscribeRun(
  store: Store,
  bus: RunBus,
  runId: RunId,
  afterSeq: number,
  onEvent: RunEventListener,
): () => void {
  let lastSeq = afterSeq;
  let live = false;
  const buffer: AnyRunEvent[] = [];

  const unsub = bus.on(runId, (e) => {
    if (!live) {
      buffer.push(e);
      return;
    }
    if (e.seq > lastSeq) {
      lastSeq = e.seq;
      onEvent(e);
    }
  });

  // Replay history.
  for (const e of store.getEvents(runId, afterSeq)) {
    lastSeq = e.seq;
    onEvent(e);
  }
  // Drain anything that arrived during replay, then go live.
  live = true;
  for (const e of buffer) {
    if (e.seq > lastSeq) {
      lastSeq = e.seq;
      onEvent(e);
    }
  }
  return unsub;
}
