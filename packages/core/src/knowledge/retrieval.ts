/**
 * Prompt-time knowledge retrieval. Instead of pushing the whole wiki (bloat) or making
 * the agent read the entire file (the pull tradeoff), the orchestrator retrieves the
 * entries most RELEVANT to the current task and injects just those.
 *
 * Signal is a pragmatic BM25-ish keyword overlap (title-weighted) — no embeddings, which
 * keeps it dependency-free and deterministic. The on-disk wiki + index still back full
 * pull for anything the keyword signal misses.
 */
import type { WikiEntry } from './wiki.js';

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'on', 'with', 'is', 'are', 'be',
  'this', 'that', 'it', 'as', 'at', 'by', 'from', 'will', 'should', 'can', 'not', 'no', 'use',
  'using', 'add', 'into', 'its', 'their', 'has', 'have', 'was', 'were', 'but', 'all', 'any',
]);

/** Lowercase word tokens, stopwords and very short tokens dropped. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Code-ish ENTITIES: identifiers and paths with internal structure (camelCase,
 * snake_case, dotted/slashed paths, ALLCAPS acronyms) — e.g. `LRUCache`, `deep_clone`,
 * `src/foo.ts`, `API`. Exact overlap between query and entry entities is a much stronger
 * signal than plain keyword overlap for a coding agent, and needs no embeddings.
 */
export function extractEntities(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z0-9_$][A-Za-z0-9_$./-]*/g) ?? []) {
    const isEntity =
      /[A-Za-z0-9][A-Z]/.test(raw) || // internal uppercase: camelCase / PascalCase / ACRONYM
      /_/.test(raw) || // snake_case
      /[./]/.test(raw); // dotted or slashed path
    if (isEntity) out.add(raw.toLowerCase());
  }
  return out;
}

/** Score one entry against a set of query terms — title matches weigh more than body. */
export function scoreEntry(entry: WikiEntry, queryTerms: ReadonlySet<string>): number {
  if (queryTerms.size === 0) return 0;
  const title = new Set(tokenize(entry.title));
  const body = tokenize(entry.body);
  let score = 0;
  for (const term of queryTerms) {
    if (title.has(term)) score += 3;
    for (const b of body) if (b === term) score += 1;
  }
  return score;
}

/**
 * The entries most relevant to `query`, highest score first (ties broken by recency),
 * capped by count and a char budget. Returns [] when nothing matches.
 */
export function retrieveRelevant(
  entries: readonly WikiEntry[],
  query: string,
  opts: { limit?: number; maxChars?: number; perEntryChars?: number } = {},
): WikiEntry[] {
  const terms = new Set(tokenize(query));
  const queryEntities = extractEntities(query);
  if (terms.size === 0 && queryEntities.size === 0) return [];
  const limit = opts.limit ?? 6;
  const maxChars = opts.maxChars ?? 1600;
  const perEntryChars = opts.perEntryChars ?? 300;
  const ranked = entries
    .map((e) => {
      // Multi-signal: keyword overlap (BM25-ish) + a strong bonus for shared code
      // entities (an exact identifier/path match, weighted higher in the title).
      let score = scoreEntry(e, terms);
      if (queryEntities.size > 0) {
        const titleEntities = extractEntities(e.title);
        const bodyEntities = extractEntities(e.body);
        for (const ent of queryEntities) {
          if (titleEntities.has(ent)) score += 6;
          else if (bodyEntities.has(ent)) score += 4;
        }
      }
      return { e, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.e.createdAt - a.e.createdAt);
  const out: WikiEntry[] = [];
  let used = 0;
  for (const { e } of ranked) {
    if (out.length >= limit) break;
    const cost = e.title.length + Math.min(e.body.length, perEntryChars) + 16;
    if (used + cost > maxChars && out.length > 0) break;
    out.push(e);
    used += cost;
  }
  return out;
}
