/**
 * Deterministic id generation for tests and per-run task ids. Real run ids use
 * a process-unique generator so a restarted daemon never reuses a stale
 * `<run>.control.json` file from an older process.
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

export function createUniqueRunIdGenerator(): IdGenerator {
  let n = 0;
  const seed = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    next(prefix = 'run'): string {
      n += 1;
      return `${prefix}-${seed}-${n}`;
    },
  };
}
