/**
 * Shared helpers for runtime defs: the synthetic "default" model option and a
 * few stdout parsers reused across several adapters.
 */
import type { RuntimeModelOption } from './types.js';

export const DEFAULT_MODEL_OPTION: RuntimeModelOption = {
  id: 'default',
  label: 'Default (CLI config)',
};

/**
 * Parse a whitespace-table model listing (pi's `--list-models` shape):
 *
 *   provider   model               context  ...
 *   anthropic  claude-sonnet-4-5   200K     ...
 *
 * Collapses to `provider/model` ids, prepending the synthetic default.
 */
export function parseProviderTableModels(
  stdout: string,
): RuntimeModelOption[] | null {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (lines.length === 0) return null;

  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>(['default']);
  // First line is the header.
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i]!.split(/\s+/);
    const provider = parts[0];
    const model = parts[1];
    if (!provider || !model) continue;
    const id = `${provider}/${model}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out.length > 1 ? out : null;
}

/** Parse one-id-per-line stdout (opencode / cursor-agent `models`). */
export function parseLineSeparatedModels(
  stdout: string,
): RuntimeModelOption[] | null {
  const ids = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>(['default']);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out.length > 1 ? out : null;
}

function isPlausibleModelId(id: string): boolean {
  if (id.length < 2 || id.length > 96) return false;
  if (!/[A-Za-z]/.test(id)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(id);
}

/** Parse one-id-per-line stdout while dropping login banners and terminal noise. */
export function parseStrictLineSeparatedModels(
  stdout: string,
): RuntimeModelOption[] | null {
  const ids = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && isPlausibleModelId(line));
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>(['default']);
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out.length > 1 ? out : null;
}

/** Parse Codex's `debug models` JSON listing. */
export function parseCodexDebugModels(
  stdout: string,
): RuntimeModelOption[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    return null;
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>(['default']);
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as {
      slug?: unknown;
      id?: unknown;
      display_name?: unknown;
      name?: unknown;
      visibility?: unknown;
    };
    if (entry.visibility === 'hidden') continue;
    const id =
      typeof entry.slug === 'string'
        ? entry.slug.trim()
        : typeof entry.id === 'string'
          ? entry.id.trim()
          : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label =
      (typeof entry.display_name === 'string' && entry.display_name.trim()) ||
      (typeof entry.name === 'string' && entry.name.trim()) ||
      id;
    out.push({ id, label });
  }
  return out.length > 1 ? out : null;
}

/**
 * Clamp a reasoning effort to what a given model family accepts. Mirrors the
 * Codex CLI's quirks (the late gpt-5 family rejects `minimal`, etc.).
 */
export function clampCodexReasoning(
  modelId: string | null | undefined,
  effort: string | null | undefined,
): string | null | undefined {
  if (!effort) return effort;
  const raw = String(modelId ?? '').trim();
  const id = raw.includes('/') ? raw.split('/').pop() ?? raw : raw;
  const isGpt5LateFamily =
    !id ||
    id === 'default' ||
    id.startsWith('gpt-5.2') ||
    id.startsWith('gpt-5.3') ||
    id.startsWith('gpt-5.4') ||
    id.startsWith('gpt-5.5');
  if (isGpt5LateFamily && effort === 'minimal') return 'low';
  if (id === 'gpt-5.1' && effort === 'xhigh') return 'high';
  return effort;
}

export const STANDARD_REASONING_OPTIONS: RuntimeModelOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'off', label: 'Off' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
];
