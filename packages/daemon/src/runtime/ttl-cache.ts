/**
 * A tiny time-to-live cache used to memoize agent resolution between runs.
 *
 * Two properties matter and are why this is its own unit:
 *   1. A read past the TTL is a miss (and lazily evicts the stale entry).
 *   2. A write sweeps every expired entry first, so a long-lived daemon that
 *      resolves across many cwd/env tuples stays bounded by the number of
 *      currently-fresh keys, not every key ever seen.
 *
 * `ttlMs <= 0` disables the cache entirely (every get misses, every set no-ops),
 * which keeps behaviour deterministic in tests that don't opt into caching.
 */
export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  clear(): void;
  readonly size: number;
}

export function createTtlCache<V>(ttlMs: number, now: () => number = () => Date.now()): TtlCache<V> {
  const map = new Map<string, { at: number; value: V }>();
  return {
    get(key: string): V | undefined {
      if (ttlMs <= 0) return undefined;
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) {
        map.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: V): void {
      if (ttlMs <= 0) return;
      const at = now();
      // Sweep expired entries so the map stays bounded by fresh keys.
      for (const [k, v] of map) {
        if (at - v.at >= ttlMs) map.delete(k);
      }
      map.set(key, { at, value });
    },
    clear(): void {
      map.clear();
    },
    get size(): number {
      return map.size;
    },
  };
}
