import { describe, expect, it } from 'vitest';
import { ProjectWiki } from '../src/knowledge/wiki.js';
import { createIdGenerator } from '../src/ids.js';
import { retrieveRelevant, tokenize } from '../src/knowledge/retrieval.js';

function wiki(): ProjectWiki {
  let t = 0;
  return new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => t++ });
}

describe('tokenize', () => {
  it('lowercases and drops stopwords + short tokens', () => {
    expect(tokenize('Use the LRUCache for caching')).toEqual(['lrucache', 'caching']);
  });
});

describe('retrieveRelevant', () => {
  it('returns the entries most relevant to the query, title-weighted', () => {
    const w = wiki();
    w.addFact({ title: 'LRU cache eviction', body: 'evict least-recently-used on capacity' });
    w.addFact({ title: 'Debounce timing', body: 'delays calls by waitMs' });
    w.addDecision({ title: 'pnpm workspaces', body: 'monorepo layout' });
    const hits = retrieveRelevant(w.list(), 'implement an LRU cache with eviction');
    expect(hits[0]?.title).toBe('LRU cache eviction');
    expect(hits.map((e) => e.title)).not.toContain('pnpm workspaces'); // irrelevant dropped
  });

  it('returns [] when nothing matches or the query is empty', () => {
    const w = wiki();
    w.addFact({ title: 'Debounce', body: 'timing' });
    expect(retrieveRelevant(w.list(), 'completely unrelated quantum entanglement')).toEqual([]);
    expect(retrieveRelevant(w.list(), '')).toEqual([]);
  });

  it('caps to the limit', () => {
    const w = wiki();
    for (let i = 0; i < 20; i++) w.addFact({ title: `cache variant ${i}`, body: 'cache cache cache' });
    expect(retrieveRelevant(w.list(), 'cache', { limit: 3 })).toHaveLength(3);
  });
});

describe('ProjectWiki.toRelevantMarkdown', () => {
  it('renders relevant entries with bodies + kind, drops the rest', () => {
    const w = wiki();
    w.addRisk({ title: 'gemini broken', body: 'gemini CLI errors with zero output' });
    w.addFact({ title: 'unrelated topic', body: 'nothing useful here' });
    const md = w.toRelevantMarkdown('how to handle gemini failures');
    expect(md).toContain('gemini broken');
    expect(md).toContain('_(risk)_');
    expect(md).not.toContain('unrelated topic');
  });
});
