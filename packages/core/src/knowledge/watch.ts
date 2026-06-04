/**
 * A debounced driver for {@link CodeGraph.update}, so a long-lived process can
 * keep a code graph fresh from a file watcher without re-scanning the whole
 * tree on every change.
 *
 * It is deliberately watcher-agnostic: the host wires whatever it already has
 * (node:fs.watch, chokidar, an LSP file-event stream, …) to {@link notify}, and
 * this batches/debounces/serializes the resulting `update()` calls. That keeps
 * the OS-specific watching out of core (and out of the test surface) while the
 * batching logic — the part that's easy to get wrong — is unit-tested.
 */
import type { CodeGraph } from './codegraph.js';

export interface CodeGraphWatcher {
  /** Queue changed paths (relative or absolute); applied as a debounced batch. */
  notify(...paths: string[]): void;
  /** Apply any pending batch immediately; resolves once the graph is updated. */
  flush(): Promise<void>;
  /** Stop: drop pending paths and cancel the pending timer. */
  stop(): void;
}

export interface CodeGraphWatchOptions {
  /** Coalesce a burst of changes for this long before re-scanning (default 100ms). */
  debounceMs?: number;
  /** Called after each applied batch with the paths that were re-scanned. */
  onUpdate?: (paths: string[]) => void;
  /** Injectable timer for deterministic tests (default setTimeout/clearTimeout). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createCodeGraphWatcher(
  graph: CodeGraph,
  options: CodeGraphWatchOptions = {},
): CodeGraphWatcher {
  const debounceMs = options.debounceMs ?? 100;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Set<string>();
  let timer: unknown;
  // Serialize batches so two quick flushes can't interleave update() calls.
  let chain: Promise<void> = Promise.resolve();

  const apply = (): Promise<void> => {
    if (pending.size === 0) return chain;
    const batch = [...pending];
    pending.clear();
    chain = chain.then(async () => {
      await graph.update(batch);
      options.onUpdate?.(batch);
    });
    return chain;
  };

  const cancelTimer = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  return {
    notify(...paths: string[]): void {
      for (const p of paths) pending.add(p);
      cancelTimer();
      timer = setTimer(() => {
        timer = undefined;
        void apply();
      }, debounceMs);
    },
    async flush(): Promise<void> {
      cancelTimer();
      await apply();
    },
    stop(): void {
      cancelTimer();
      pending.clear();
    },
  };
}
