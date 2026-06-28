/**
 * Parse the wiki-curator's structured output into typed SEMANTIC entries.
 *
 * The curator is asked to emit a fenced `knowledge` block of `kind | title | body`
 * lines (see {@link Orchestrator.wikiCuratorPrompt}). Storing its raw free-text instead
 * mixed EPISODIC narration ("I'll first locate… the patch missed…") into semantic
 * memory and bloated every prompt. Parsing distills it: only well-formed lines become
 * entries; surrounding prose is discarded.
 */
export interface CuratedEntry {
  kind: 'fact' | 'decision' | 'risk';
  title: string;
  body: string;
}

const LINE_RE = /^\s*[-*]?\s*(fact|decision|risk)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/i;

export function parseCuratedKnowledge(text: string): CuratedEntry[] {
  if (!text) return [];
  // Prefer the fenced block when present; otherwise scan every line (a lenient
  // fallback for a curator that forgot the fence but used the line shape).
  const fence = /```(?:knowledge)?[ \t]*\n([\s\S]*?)```/i.exec(text);
  const scope = fence ? fence[1] : text;
  const seen = new Set<string>();
  const out: CuratedEntry[] = [];
  for (const raw of scope.split('\n')) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const kind = m[1].toLowerCase() as CuratedEntry['kind'];
    const title = m[2].trim();
    const body = m[3].trim();
    if (!title || !body) continue;
    const key = `${kind}:${title.toLowerCase()}`;
    if (seen.has(key)) continue; // de-dupe within one curation pass
    seen.add(key);
    out.push({ kind, title, body });
  }
  return out;
}
