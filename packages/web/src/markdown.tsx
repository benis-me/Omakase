// A deliberately tiny markdown renderer for agent output: paragraphs, fenced and
// inline code, bullet lists, bold, and links. It renders to React nodes (never
// dangerouslySetInnerHTML), so untrusted model text can't inject markup.
import type { ReactNode } from 'react';

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // `code` | **bold** | [label](url)
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) nodes.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('**')) nodes.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else {
      const mm = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/.exec(tok)!;
      nodes.push(
        <a key={key} href={mm[2]} target="_blank" rel="noreferrer noopener">
          {mm[1]}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }): ReactNode {
  const src = text.trim();
  if (!src) return null;
  const out: ReactNode[] = [];
  const lines = src.split('\n');
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++; // closing fence
      out.push(
        <pre key={k++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, ''));
      out.push(
        <ul key={k++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    // Gather a paragraph (consecutive non-blank, non-special lines).
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !lines[i]!.startsWith('```') && !/^\s*[-*]\s+/.test(lines[i]!)) {
      para.push(lines[i++]!);
    }
    out.push(<p key={k++}>{inline(para.join(' '), `p${k}`)}</p>);
  }
  return <div className="md">{out}</div>;
}
