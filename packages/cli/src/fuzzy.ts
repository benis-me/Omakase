/**
 * A tiny dependency-free fuzzy matcher shared by every selector overlay
 * (commands, files, sessions, agents). Pure and unit-tested.
 */
export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 3; // contiguous run
    if (at === 0 || /[^a-z0-9]/.test(t[at - 1] ?? '')) score += 2; // start-of-word
    prev = at;
    ti = at + 1;
  }
  return score - text.length * 0.01; // prefer shorter haystacks on ties
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (query === '') return items;
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(key(item), query);
    if (s !== null) scored.push({ item, score: s, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.item);
}
