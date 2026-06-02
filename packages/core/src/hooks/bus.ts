/**
 * A small, strongly-typed hook bus. Handlers register against named hook points
 * with an optional priority and run sequentially (highest priority first, then
 * registration order). Each handler may be sync or async.
 *
 * Failure policy is per-emit: `throw` stops at and rethrows the first error;
 * `continue` runs every handler and reports errors via the `onError` callback.
 */
export type HookHandler<P> = (payload: P) => void | Promise<void>;

export interface HookHandle {
  remove(): void;
}

export type HookFailureMode = 'throw' | 'continue';

interface HookEntry<P> {
  handler: HookHandler<P>;
  priority: number;
  seq: number;
}

export interface EmitOptions {
  failureMode?: HookFailureMode;
  onError?: (error: unknown) => void;
}

export class HookBus<M extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof M, Array<HookEntry<unknown>>>();
  private seq = 0;

  on<K extends keyof M>(
    name: K,
    handler: HookHandler<M[K]>,
    options: { priority?: number } = {},
  ): HookHandle {
    const list = this.handlers.get(name) ?? [];
    const entry: HookEntry<unknown> = {
      handler: handler as HookHandler<unknown>,
      priority: options.priority ?? 0,
      seq: this.seq++,
    };
    list.push(entry);
    this.handlers.set(name, list);
    return {
      remove: () => {
        const current = this.handlers.get(name);
        if (!current) return;
        const idx = current.indexOf(entry);
        if (idx !== -1) current.splice(idx, 1);
      },
    };
  }

  off<K extends keyof M>(name: K, handler: HookHandler<M[K]>): void {
    const list = this.handlers.get(name);
    if (!list) return;
    this.handlers.set(
      name,
      list.filter((e) => e.handler !== (handler as HookHandler<unknown>)),
    );
  }

  count<K extends keyof M>(name: K): number {
    return this.handlers.get(name)?.length ?? 0;
  }

  /** Registered handlers for a hook, in execution order. */
  private ordered<K extends keyof M>(name: K): Array<HookEntry<unknown>> {
    const list = this.handlers.get(name);
    if (!list) return [];
    return [...list].sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }

  async emit<K extends keyof M>(
    name: K,
    payload: M[K],
    options: EmitOptions = {},
  ): Promise<void> {
    const mode = options.failureMode ?? 'continue';
    for (const entry of this.ordered(name)) {
      try {
        await entry.handler(payload);
      } catch (error) {
        if (mode === 'throw') throw error;
        options.onError?.(error);
      }
    }
  }
}
