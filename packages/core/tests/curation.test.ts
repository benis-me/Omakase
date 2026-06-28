import { describe, expect, it } from 'vitest';
import { parseCuratedKnowledge } from '../src/knowledge/curation.js';

describe('parseCuratedKnowledge (episodic→semantic distillation)', () => {
  it('extracts typed entries from a fenced block, discarding surrounding narration', () => {
    const text = [
      "Using superpowers. I'll first locate the conventions. I found .omks/memory; the patch missed spacing, so I retried…",
      '```knowledge',
      'fact | Uses pnpm workspaces | The monorepo is pnpm + TypeScript ESM',
      'decision | ESM only | NodeNext modules everywhere, no CommonJS',
      'risk | gemini broken | the gemini CLI errors with 0 output — prefer codex',
      '```',
      'I did not create a command file because nothing here was reusable.',
    ].join('\n');
    const out = parseCuratedKnowledge(text);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'fact', title: 'Uses pnpm workspaces', body: 'The monorepo is pnpm + TypeScript ESM' });
    expect(out[2].kind).toBe('risk');
    expect(JSON.stringify(out)).not.toContain('first locate'); // narration gone
  });

  it('returns nothing for pure narration (the old curator failure mode)', () => {
    expect(
      parseCuratedKnowledge("Using `superpowers`… I'll first locate the wiki conventions, then write durable content."),
    ).toEqual([]);
  });

  it('falls back to scanning lines when the fence is missing', () => {
    const out = parseCuratedKnowledge('fact | A | body a\nrisk | B | body b');
    expect(out.map((e) => e.kind)).toEqual(['fact', 'risk']);
  });

  it('de-dupes repeated kind+title and drops malformed / wrong-kind lines', () => {
    const out = parseCuratedKnowledge(
      ['```knowledge', 'fact | Same | first wins', 'fact | Same | duplicate dropped', 'note | bad kind | dropped', 'fact |  | no title dropped', '```'].join('\n'),
    );
    expect(out).toHaveLength(1);
    expect(out[0].body).toBe('first wins');
  });
});
