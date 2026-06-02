/**
 * Deterministic id generation. Real runs use a monotonic counter; tests inject
 * a fresh generator so ids are stable and assertions don't depend on clocks or
 * randomness (both of which would also break run replay).
 */
export interface IdGenerator {
  next(prefix?: string): string;
}

export function createIdGenerator(seed = 0): IdGenerator {
  let n = seed;
  return {
    next(prefix = 'id'): string {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}
