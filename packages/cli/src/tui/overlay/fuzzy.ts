/**
 * A tiny, dependency-free fuzzy matcher shared by every overlay (command
 * palette, file finder, session/model/agent selectors). Pure and unit-tested:
 * {@link fuzzyScore} ranks a single candidate, {@link fuzzyFilter} ranks a list.
 */

/**
 * Score how well `query` fuzzy-matches `text` (higher is better), or `null` if
 * `query` is not a subsequence of `text`. An empty query matches everything
 * with score 0. Contiguous runs and start-of-word matches score higher.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2;
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    score += 1;
    if (found === prevMatch + 1) score += 3; // contiguous run bonus
    if (found === 0 || /[^a-z0-9]/.test(t[found - 1] ?? '')) score += 2; // start-of-word bonus
    prevMatch = found;
    ti = found + 1;
  }
  // Prefer shorter haystacks on ties (a closer overall match).
  return score - text.length * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (query === '') return items;
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(key(item), query);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.item);
}
