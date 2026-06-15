import { describe, expect, it } from 'vitest';
import { tokenizeMarkdown, type MdBlock } from '../src/tui/render/markdown.js';
import { tokenizeDiff } from '../src/tui/render/diff.js';

describe('tokenizeMarkdown', () => {
  it('parses headings, paragraphs, lists and fenced code', () => {
    const src = [
      '# Title',
      '',
      'A paragraph with **bold** and `code`.',
      '',
      '- first',
      '- second',
      '',
      '```ts',
      'const x = 1;',
      '```',
    ].join('\n');
    const blocks = tokenizeMarkdown(src);
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(['heading', 'paragraph', 'list-item', 'list-item', 'code-block']);

    const heading = blocks[0] as Extract<MdBlock, { kind: 'heading' }>;
    expect(heading.level).toBe(1);
    expect(heading.spans.map((s) => s.text).join('')).toBe('Title');

    const para = blocks[1] as Extract<MdBlock, { kind: 'paragraph' }>;
    expect(para.spans.find((s) => s.bold)?.text).toBe('bold');
    expect(para.spans.find((s) => s.code)?.text).toBe('code');

    const code = blocks[4] as Extract<MdBlock, { kind: 'code-block' }>;
    expect(code.lang).toBe('ts');
    expect(code.lines).toEqual(['const x = 1;']);
  });

  it('treats an ordered list and keeps its marker', () => {
    const blocks = tokenizeMarkdown('1. one\n2. two');
    expect(blocks.every((b) => b.kind === 'list-item')).toBe(true);
    const first = blocks[0] as Extract<MdBlock, { kind: 'list-item' }>;
    expect(first.ordered).toBe(true);
    expect(first.spans.map((s) => s.text).join('')).toBe('one');
  });
});

describe('tokenizeDiff', () => {
  it('classifies hunk headers, additions, deletions, context and meta', () => {
    const patch = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,3 +1,4 @@',
      ' context line',
      '-removed',
      '+added',
    ].join('\n');
    const lines = tokenizeDiff(patch);
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add']);
    expect(lines.find((l) => l.kind === 'add')?.text).toBe('+added');
  });
});
