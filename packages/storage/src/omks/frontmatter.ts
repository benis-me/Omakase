/**
 * Minimal YAML-frontmatter reader/writer for authored `.omks` documents (specs,
 * agents, commands). A document is `---\n<yaml>\n---\n\n<body>`. Parsing never
 * throws: malformed frontmatter yields empty data + the original text as body,
 * so a hand-edited file can't crash the workspace loader.
 */
import { parse, stringify } from 'yaml';

export interface FrontmatterDoc {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

export function parseFrontmatter(text: string): FrontmatterDoc {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parse(match[1]) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: match[2] ?? '' };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, { lineWidth: 0 }).replace(/\n+$/, '');
  const trimmedBody = body.replace(/^\n+/, '');
  const suffix = trimmedBody.endsWith('\n') || trimmedBody === '' ? '' : '\n';
  return `---\n${yaml}\n---\n\n${trimmedBody}${suffix}`;
}

// ── Typed coercion helpers (frontmatter values are `unknown`) ────────────────

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}
