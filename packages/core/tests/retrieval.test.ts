import { describe, expect, it } from 'vitest';
import { ProjectWiki } from '../src/knowledge/wiki.js';
import { createIdGenerator } from '../src/ids.js';
import { retrieveRelevant, tokenize, extractEntities } from '../src/knowledge/retrieval.js';

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

describe('extractEntities', () => {
  it('picks code-ish identifiers/paths, ignores plain words', () => {
    const ents = extractEntities('fix deepClone in src/clone.ts for the LRUCache and snake_case');
    expect(ents.has('deepclone')).toBe(true); // camelCase
    expect(ents.has('src/clone.ts')).toBe(true); // path
    expect(ents.has('lrucache')).toBe(true); // PascalCase
    expect(ents.has('snake_case')).toBe(true); // snake_case
    expect(ents.has('fix')).toBe(false); // plain word
    expect(ents.has('the')).toBe(false);
  });
});

describe('retrieveRelevant — entity signal outranks plain keyword overlap', () => {
  it('ranks an exact identifier match above a generic keyword match', () => {
    let t = 0;
    const w = new ProjectWiki({ idGenerator: createIdGenerator(), clock: () => t++ });
    w.addFact({ title: 'Generic caching notes', body: 'cache things to make them fast' });
    w.addDecision({ title: 'deepClone handles Maps', body: 'deepClone clones Date and Map' });
    const hits = retrieveRelevant(w.list(), 'fix a bug in deepClone');
    expect(hits[0]?.title).toBe('deepClone handles Maps'); // entity match wins
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
