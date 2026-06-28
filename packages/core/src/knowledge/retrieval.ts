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
  if (terms.size === 0) return [];
  const limit = opts.limit ?? 6;
  const maxChars = opts.maxChars ?? 1600;
  const perEntryChars = opts.perEntryChars ?? 300;
  const ranked = entries
    .map((e) => ({ e, score: scoreEntry(e, terms) }))
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
