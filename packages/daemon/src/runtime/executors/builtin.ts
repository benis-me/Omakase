/**
 * In-process agents that need no subprocess. These are real, deterministic
 * executors — not stubs — so that:
 *   - tests can drive the orchestrator with no model and no binaries,
 *   - `omakase run` works offline out of the box, and
 *   - the core's router/planner/worker/reviewer roles always have a default
 *     execution base even when no agent CLI is installed.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../../protocol/events.js';
import type { AgentExecutor, AgentRunInput, ExecutorContext } from '../executor.js';
import { arrayToAsync, isAsyncIterable, streamFromDriver } from '../stream.js';

export type ScriptedHandler = (
  input: AgentRunInput,
  ctx: ExecutorContext,
) =>
  | AgentEvent[]
  | AsyncIterable<AgentEvent>
  | Promise<AgentEvent[] | AsyncIterable<AgentEvent>>;

/**
 * Wrap a handler into an executor. The handler returns (or yields) the content
 * events; status/done bookkeeping is handled for you.
 */
export function createScriptedAgent(
  handler: ScriptedHandler,
  options: { label?: string } = {},
): AgentExecutor {
  return (ctx) =>
    streamFromDriver(ctx, async (push, c) => {
      push({
        type: 'status',
        label: 'working',
        model: c.input.model ?? options.label ?? 'builtin',
      });
      const produced = await handler(c.input, c);
      const iterable = isAsyncIterable<AgentEvent>(produced)
        ? produced
        : arrayToAsync(produced);
      for await (const event of iterable) push(event);
      return 'completed';
    });
}

/** A trivial deterministic agent that echoes the prompt back. */
export const echoAgent = createScriptedAgent((input) => [
  { type: 'text_delta', delta: input.prompt },
  { type: 'usage', usage: { inputTokens: input.prompt.length, outputTokens: input.prompt.length } },
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.html',
  '.yml', '.yaml', '.toml', '.py', '.go', '.rs', '.sh',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next']);

interface ProjectScan {
  fileCount: number;
  byExtension: Map<string, number>;
  topLevel: string[];
}

async function scanProject(root: string, maxFiles = 4000): Promise<ProjectScan> {
  const byExtension = new Map<string, number>();
  let fileCount = 0;
  const topLevel: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (fileCount >= maxFiles) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.omakase') continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0) topLevel.push(`${entry.name}/`);
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        if (depth === 0) topLevel.push(entry.name);
        fileCount += 1;
        const ext = path.extname(entry.name) || '(none)';
        byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);
      }
    }
  };

  await walk(root, 0);
  return { fileCount, byExtension, topLevel: topLevel.sort() };
}

async function readJsonSafe(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readFirstParagraph(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    const body: string[] = [];
    for (const line of lines) {
      if (line.startsWith('#')) continue;
      if (line.trim() === '' && body.length > 0) break;
      if (line.trim() !== '') body.push(line.trim());
      if (body.length >= 3) break;
    }
    const para = body.join(' ').trim();
    return para.length > 0 ? para.slice(0, 400) : null;
  } catch {
    return null;
  }
}

/** Produce a real, deterministic project summary by reading the filesystem. */
export async function summarizeProject(root: string): Promise<string> {
  try {
    await stat(root);
  } catch {
    return `Could not read project at ${root}.`;
  }
  const [scan, pkg, readme] = await Promise.all([
    scanProject(root),
    readJsonSafe(path.join(root, 'package.json')),
    readFirstParagraph(path.join(root, 'README.md')),
  ]);

  const lines: string[] = [];
  const name = typeof pkg?.name === 'string' ? pkg.name : path.basename(root);
  lines.push(`# Project summary: ${name}`);
  if (typeof pkg?.description === 'string') lines.push('', pkg.description);
  if (readme) lines.push('', `README: ${readme}`);

  const scripts = pkg?.scripts;
  if (scripts && typeof scripts === 'object') {
    const names = Object.keys(scripts as Record<string, unknown>);
    if (names.length > 0) lines.push('', `Scripts: ${names.join(', ')}`);
  }

  const exts = [...scan.byExtension.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  lines.push(
    '',
    `Files scanned: ${scan.fileCount}`,
    `By type: ${exts.map(([ext, n]) => `${ext} ${n}`).join(', ')}`,
    `Top level: ${scan.topLevel.slice(0, 20).join(' ')}`,
  );
  return lines.join('\n');
}

/**
 * The default offline agent. It reasons briefly, then either summarizes the
 * working directory (for "summarize" intents) or acknowledges the request.
 * This is the runtime's fallback when no agent CLI is installed.
 */
export const localResponderAgent = createScriptedAgent(async (input) => {
  const events: AgentEvent[] = [];
  const role = typeof input.metadata?.role === 'string' ? input.metadata.role : undefined;

  // As a reviewer with no model available, the built-in agent cannot judge
  // quality — it approves rather than blocking the run, and says so. Plug in a
  // real agent for rigorous review.
  if (role === 'reviewer') {
    events.push({
      type: 'text_delta',
      delta:
        'APPROVE — built-in reviewer cannot evaluate deeply without a model; approving to avoid blocking. Configure a real agent for rigorous review.',
    });
    events.push({ type: 'usage', usage: { inputTokens: input.prompt.length, outputTokens: 0 } });
    return events;
  }

  events.push({ type: 'thinking_start' });
  events.push({
    type: 'thinking_delta',
    delta: `Interpreting request: ${input.prompt.slice(0, 200)}`,
  });
  events.push({ type: 'thinking_end' });

  const lower = input.prompt.toLowerCase();
  if ((lower.includes('summar') || lower.includes('overview')) && input.cwd) {
    events.push({ type: 'text_delta', delta: await summarizeProject(input.cwd) });
  } else {
    events.push({
      type: 'text_delta',
      delta: `Acknowledged: ${input.prompt.trim()}`,
    });
  }
  events.push({
    type: 'usage',
    usage: { inputTokens: input.prompt.length, outputTokens: 0 },
  });
  return events;
}, { label: 'omakase-builtin' });
