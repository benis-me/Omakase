import { describe, expect, it } from 'vitest';
import { fuzzyScore, fuzzyFilter } from '../src/tui/overlay/fuzzy.js';

describe('fuzzyScore', () => {
  it('matches subsequences and rejects non-matches', () => {
    expect(fuzzyScore('model', 'ml')).not.toBeNull(); // m..l
    expect(fuzzyScore('model', 'mod')).not.toBeNull();
    expect(fuzzyScore('model', 'xyz')).toBeNull();
    expect(fuzzyScore('model', '')).toBe(0); // empty query matches everything
  });

  it('scores contiguous and start-of-word matches higher', () => {
    const contiguous = fuzzyScore('session', 'ses')!;
    const scattered = fuzzyScore('session', 'sin')!; // s..i..n
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('Workflow', 'wf')).not.toBeNull();
  });
});

describe('fuzzyFilter', () => {
  it('returns matching items ranked best-first', () => {
    const items = ['/new', '/sessions', '/stop', '/workflow'];
    const out = fuzzyFilter(items, 's', (s) => s);
    expect(out[0]).toMatch(/^\/s/); // a leading-s command ranks first
    expect(out).not.toContain('/new');
  });

  it('returns all items for an empty query, original order', () => {
    const items = ['a', 'b', 'c'];
    expect(fuzzyFilter(items, '', (s) => s)).toEqual(items);
  });
});
