import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzyFilter } from '../src/fuzzy.js';

describe('fuzzy', () => {
  it('matches subsequences, rejects non-matches, ranks contiguous higher', () => {
    expect(fuzzyScore('model', 'ml')).not.toBeNull();
    expect(fuzzyScore('model', 'xyz')).toBeNull();
    expect(fuzzyScore('model', '')).toBe(0);
    expect(fuzzyScore('session', 'ses')!).toBeGreaterThan(fuzzyScore('session', 'sin')!);
  });

  it('filters and ranks a list best-first, empty query keeps order', () => {
    const items = ['/new', '/sessions', '/stop', '/workflow'];
    expect(fuzzyFilter(items, 's', (s) => s)[0]).toMatch(/^\/s/);
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items);
  });
});
