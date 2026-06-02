/**
 * A dependency-free YAML-frontmatter parser covering the subset SKILL.md
 * files use: scalar strings/numbers/booleans/null, nested maps by indentation,
 * arrays of scalars (and shallow arrays of maps), block scalars (`|`/`>`),
 * inline arrays (`[a, b]`), and quoted strings. For anything richer, swap in a
 * real YAML library — the skill loader only depends on this surface.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedFrontmatter {
  data: FrontmatterData;
  body: string;
}

export function parseFrontmatter(src: string): ParsedFrontmatter {
  const text = src.replace(/^﻿/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  const lines = (match[1] ?? '').split(/\r?\n/);
  const [data] = parseMap(lines, 0, 0);
  return { data, body: match[2] ?? '' };
}

function leadingSpaces(line: string): number {
  const m = /^[ ]*/.exec(line);
  return m ? m[0].length : 0;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Index of the colon that separates a key from its value (`: ` or trailing `:`). */
function findColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble && (i + 1 >= s.length || s[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

function coerce(raw: string): FrontmatterScalar {
  const v = raw.trim();
  if (v === '') return '';
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

function parseInlineArray(raw: string): FrontmatterValue[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => coerce(part.trim()));
}

function parseMap(
  lines: string[],
  start: number,
  indent: number,
): [FrontmatterData, number] {
  const map: FrontmatterData = {};
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    if (isBlankOrComment(raw)) {
      i += 1;
      continue;
    }
    const ind = leadingSpaces(raw);
    if (ind < indent) break;
    if (ind > indent) {
      i += 1;
      continue;
    }
    const content = raw.slice(indent);
    if (content.startsWith('- ')) break;
    const colon = findColon(content);
    if (colon === -1) {
      i += 1;
      continue;
    }
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    if (rest === '') {
      const [value, next] = parseNested(lines, i + 1, indent);
      map[key] = value;
      i = next;
    } else if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const [block, next] = parseBlockScalar(lines, i + 1, indent);
      map[key] = block;
      i = next;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      map[key] = parseInlineArray(rest);
      i += 1;
    } else {
      map[key] = coerce(rest);
      i += 1;
    }
  }
  return [map, i];
}

function parseNested(
  lines: string[],
  start: number,
  parentIndent: number,
): [FrontmatterValue, number] {
  let j = start;
  while (j < lines.length && isBlankOrComment(lines[j] ?? '')) j += 1;
  if (j >= lines.length) return ['', j];
  const ind = leadingSpaces(lines[j] ?? '');
  if (ind <= parentIndent) return ['', start];
  const content = (lines[j] ?? '').slice(ind);
  if (content.startsWith('- ')) return parseList(lines, j, ind);
  return parseMap(lines, j, ind);
}

function parseList(
  lines: string[],
  start: number,
  indent: number,
): [FrontmatterValue[], number] {
  const arr: FrontmatterValue[] = [];
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    if (isBlankOrComment(raw)) {
      i += 1;
      continue;
    }
    const ind = leadingSpaces(raw);
    if (ind < indent) break;
    if (ind > indent) {
      i += 1;
      continue;
    }
    const content = raw.slice(indent);
    if (!content.startsWith('- ')) break;
    const item = content.slice(2).trim();
    const colon = findColon(item);
    if (item !== '' && colon !== -1 && !item.startsWith('"') && !item.startsWith("'")) {
      const map: FrontmatterData = {};
      const key = item.slice(0, colon).trim();
      const value = item.slice(colon + 1).trim();
      if (value) map[key] = coerce(value);
      const [more, next] = parseMap(lines, i + 1, indent + 2);
      Object.assign(map, more);
      arr.push(map);
      i = next;
    } else {
      arr.push(coerce(item));
      i += 1;
    }
  }
  return [arr, i];
}

function parseBlockScalar(
  lines: string[],
  start: number,
  parentIndent: number,
): [string, number] {
  const collected: string[] = [];
  let i = start;
  let blockIndent = -1;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) break;
    if (raw.trim() === '') {
      collected.push('');
      i += 1;
      continue;
    }
    const ind = leadingSpaces(raw);
    if (ind <= parentIndent) break;
    if (blockIndent === -1) blockIndent = ind;
    collected.push(raw.slice(blockIndent));
    i += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return [collected.join('\n'), i];
}
