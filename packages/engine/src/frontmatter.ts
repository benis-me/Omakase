// A minimal, dependency-free frontmatter parser for WORKFLOW.md files and
// flat-file header comments. Supports scalars, booleans, numbers, inline
// [a, b] arrays and block "- item" arrays. Not a full YAML implementation —
// intentionally small and predictable.

export type FrontmatterValue = string | number | boolean | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

function coerce(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter((s) => s.length > 0);
  }
  return unquote(v);
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse a `---`-delimited frontmatter block. Returns data + the remaining body. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const normalized = text.replace(/^﻿/, '');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(normalized);
  if (!m) return { data: {}, body: normalized };
  const body = normalized.slice(m[0].length);
  const data: Frontmatter = {};
  const lines = m[1]!.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const rest = kv[2]!;
    if (rest.trim() === '') {
      // Possibly a block list following.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) {
        items.push(unquote(lines[++i]!.replace(/^\s*-\s+/, '').trim()));
      }
      data[key] = items.length ? items : '';
    } else {
      data[key] = coerce(rest);
    }
  }
  return { data, body };
}

/** Parse `// key: value` header comments from a flat .ts workflow file. */
export function parseCommentMeta(text: string): Frontmatter {
  const data: Frontmatter = {};
  for (const line of text.split('\n')) {
    const m = /^\s*\/\/\s*([A-Za-z0-9_-]+):\s*(.+)$/.exec(line);
    if (m) {
      data[m[1]!] = coerce(m[2]!);
      continue;
    }
    // Stop at the first non-comment, non-blank line.
    if (line.trim() && !line.trim().startsWith('//')) break;
  }
  return data;
}

export function asString(v: FrontmatterValue | undefined, fallback = ''): string {
  if (v === undefined) return fallback;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

export function asStringArray(v: FrontmatterValue | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [String(v)];
}
