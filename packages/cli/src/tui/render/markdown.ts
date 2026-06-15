/**
 * A pragmatic, dependency-free markdown tokenizer for the chat transcript.
 * It covers what agents actually emit — headings, paragraphs, ordered/unordered
 * lists, fenced code blocks, and inline bold/italic/code — and stops there. Pure
 * and line-oriented so it is fully unit-testable; {@link renderMarkdown} maps the
 * blocks to Ink elements.
 */
export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type MdBlock =
  | { kind: 'heading'; level: number; spans: InlineSpan[] }
  | { kind: 'paragraph'; spans: InlineSpan[] }
  | { kind: 'list-item'; ordered: boolean; marker: string; spans: InlineSpan[] }
  | { kind: 'code-block'; lang: string; lines: string[] };

/** Split a single line of text into styled inline spans. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  // Order matters: code first (it suppresses other markers inside backticks),
  // then bold (**), then italic (* or _).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('**')) spans.push({ text: token.slice(2, -2), bold: true });
    else spans.push({ text: token.slice(1, -1), italic: true });
    last = m.index + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length > 0 ? spans : [{ text }];
}

export function tokenizeMarkdown(src: string): MdBlock[] {
  const lines = src.split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ kind: 'code-block', lang, lines: body });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, spans: parseInline(heading[2]!.trim()) });
      i += 1;
      continue;
    }
    const unordered = /^[-*]\s+(.*)$/.exec(line);
    if (unordered) {
      blocks.push({ kind: 'list-item', ordered: false, marker: '•', spans: parseInline(unordered[1]!) });
      i += 1;
      continue;
    }
    const ordered = /^(\d+)\.\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({ kind: 'list-item', ordered: true, marker: `${ordered[1]}.`, spans: parseInline(ordered[2]!) });
      i += 1;
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    // Gather consecutive non-blank, non-block lines into one paragraph.
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !/^[-*]\s/.test(lines[i]!) &&
      !/^\d+\.\s/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', spans: parseInline(para.join(' ')) });
  }
  return blocks;
}
