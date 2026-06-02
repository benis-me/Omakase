/**
 * The inbox holds user input that arrives while a run is in flight — new
 * requirements, mid-run instructions, or interrupts. The orchestrator drains
 * it at iteration boundaries and triggers a replan when there is fresh input.
 */
import { createIdGenerator, type IdGenerator } from './ids.js';
import type { InboxItemSnapshot } from './run-events.js';

export type InboxItemKind = 'requirement' | 'instruction' | 'interrupt';

export interface InboxItem extends InboxItemSnapshot {
  kind: InboxItemKind;
}

export interface InboxAppendOptions {
  kind?: InboxItemKind;
  priority?: number;
}

export interface InboxOptions {
  idGenerator?: IdGenerator;
  clock?: () => number;
}

export class Inbox {
  private items: InboxItem[] = [];
  private readonly ids: IdGenerator;
  private readonly clock: () => number;

  constructor(options: InboxOptions = {}) {
    this.ids = options.idGenerator ?? createIdGenerator();
    this.clock = options.clock ?? (() => Date.now());
  }

  append(text: string, options: InboxAppendOptions = {}): InboxItem {
    const item: InboxItem = {
      id: this.ids.next('inbox'),
      kind: options.kind ?? 'requirement',
      text,
      priority: options.priority ?? 0,
      createdAt: this.clock(),
      consumed: false,
    };
    this.items.push(item);
    return item;
  }

  pending(): InboxItem[] {
    return this.items
      .filter((i) => !i.consumed)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
  }

  hasPending(): boolean {
    return this.items.some((i) => !i.consumed);
  }

  /** Mark all pending items consumed and return them (highest priority first). */
  drain(): InboxItem[] {
    const pending = this.pending();
    for (const item of pending) item.consumed = true;
    return pending;
  }

  reprioritize(id: string, priority: number): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    item.priority = priority;
    return true;
  }

  snapshot(): InboxItemSnapshot[] {
    return this.items.map((i) => ({ ...i }));
  }

  static restore(items: InboxItemSnapshot[], options: InboxOptions = {}): Inbox {
    let maxSeq = 0;
    for (const i of items) {
      const m = /-(\d+)$/.exec(i.id);
      if (m) maxSeq = Math.max(maxSeq, Number.parseInt(m[1]!, 10));
    }
    const inbox = new Inbox({
      ...options,
      idGenerator: options.idGenerator ?? createIdGenerator(maxSeq),
    });
    inbox.items = items.map((i) => ({ ...i, kind: i.kind }));
    return inbox;
  }
}
