import { describe, expect, it } from 'vitest';
import { createTtlCache } from '../src/runtime/ttl-cache.js';

describe('createTtlCache', () => {
  it('serves a value within the TTL and misses (lazily evicting) after it', () => {
    let t = 0;
    const c = createTtlCache<string>(100, () => t);
    c.set('k', 'v');
    expect(c.get('k')).toBe('v');
    t = 99;
    expect(c.get('k')).toBe('v');
    t = 100; // at the boundary the entry is stale
    expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0); // the stale read evicted it
  });

  it('sweeps expired entries on write, staying bounded by fresh keys', () => {
    let t = 0;
    const c = createTtlCache<number>(100, () => t);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.size).toBe(2);
    t = 150; // a and b are now expired
    c.set('c', 3); // the write sweeps the stale entries first
    expect(c.size).toBe(1);
    expect(c.get('c')).toBe(3);
    expect(c.get('a')).toBeUndefined();
  });

  it('is fully disabled when ttl <= 0', () => {
    const c = createTtlCache<string>(0, () => 0);
    c.set('k', 'v');
    expect(c.get('k')).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it('clear() empties the cache', () => {
    const c = createTtlCache<string>(100, () => 0);
    c.set('k', 'v');
    c.clear();
    expect(c.size).toBe(0);
  });
});
