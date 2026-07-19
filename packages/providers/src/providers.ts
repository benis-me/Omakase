// Provider definitions — one per agent CLI. Flags verified against the live
// binaries (claude 2.x, codex, gemini, cursor-agent) on macOS.

import type { AgentProvider, TurnContext, SpawnPlan } from './types.ts';
import { ClaudeStreamParser, GenericJsonParser, CodexJsonParser, CursorStreamParser, TextTailParser } from './parsers.ts';
import { augmentedPath } from './env.ts';

/** For providers without a system-prompt flag, fold it into the prompt. */
function withSystem(ctx: TurnContext): string {
  if (!ctx.systemPrompt) return ctx.prompt;
  return `${ctx.systemPrompt}\n\n--- TASK ---\n\n${ctx.prompt}`;
}

// --- Claude Code -----------------------------------------------------------

export const claudeProvider: AgentProvider = {
  id: 'claude',
  command: 'claude',
  label: 'Claude Code',
  seedModels: ['opus', 'sonnet', 'haiku'],
  fastModel: 'haiku',
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  plan(ctx): SpawnPlan {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    args.push(...permissionArgs('claude', ctx.permission));
    if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
    else if (ctx.plannedSessionId) args.push('--session-id', ctx.plannedSessionId);
    const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content: ctx.prompt } }) + '\n';
    return { args, stdin, outputFormat: 'claude-stream-json' };
  },
  createParser: () => new ClaudeStreamParser(),
};

// --- OpenAI Codex ----------------------------------------------------------

export const codexProvider: AgentProvider = {
  id: 'codex',
  command: 'codex',
  label: 'Codex CLI',
  seedModels: ['gpt-5', 'o4-mini'],
  fastModel: 'o4-mini',
  apiKeyEnv: ['OPENAI_API_KEY', 'OPENAI_ORG_ID'],
  plan(ctx): SpawnPlan {
    const head = ctx.resumeSessionId ? ['exec', 'resume', ctx.resumeSessionId] : ['exec'];
    const args = [
      ...head,
      '--json',
      '--skip-git-repo-check',
      '-C',
      ctx.cwd,
      '-o',
      ctx.scratchFile,
    ];
    args.push(...permissionArgs('codex', ctx.permission));
    if (ctx.model) args.push('-m', ctx.model);
    args.push(withSystem(ctx)); // prompt as final positional
    return { args, outputFormat: 'codex-json', lastMessageFile: ctx.scratchFile };
  },
  createParser: () => new CodexJsonParser(),
  async discoverModels(command) {
    return await probeJsonModels(command, ['debug', 'models']);
  },
};

// --- Google Gemini ---------------------------------------------------------

export const geminiProvider: AgentProvider = {
  id: 'gemini',
  command: 'gemini',
  label: 'Gemini CLI',
  seedModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  fastModel: 'gemini-2.5-flash',
  apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  plan(ctx): SpawnPlan {
    const args = ['-o', 'stream-json'];
    args.push(...permissionArgs('gemini', ctx.permission));
    if (ctx.model) args.push('-m', ctx.model);
    if (ctx.resumeSessionId) args.push('-r', ctx.resumeSessionId);
    args.push(withSystem(ctx)); // positional query
    return { args, outputFormat: 'gemini-json' };
  },
  createParser: () =>
    new GenericJsonParser({
      sessionIdKeys: ['session_id', 'sessionId', 'id'],
      finalFromFile: false,
      textKeys: ['content', 'text', 'response', 'delta', 'message'],
    }),
};

// --- Cursor Agent ----------------------------------------------------------

export const cursorProvider: AgentProvider = {
  id: 'cursor-agent',
  command: 'cursor-agent',
  label: 'Cursor Agent',
  seedModels: ['gpt-5', 'sonnet-4', 'sonnet-4-thinking'],
  fastModel: 'gpt-5',
  apiKeyEnv: ['CURSOR_API_KEY'],
  plan(ctx): SpawnPlan {
    const args = ['-p', '--output-format', 'stream-json'];
    args.push(...permissionArgs('cursor-agent', ctx.permission));
    if (ctx.model) args.push('--model', ctx.model);
    if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
    args.push(withSystem(ctx)); // positional prompt
    return { args, outputFormat: 'cursor-stream-json' };
  },
  createParser: () => new CursorStreamParser(),
  async discoverModels(command) {
    return await probeLineModels(command, ['models']);
  },
};

// --- Extra providers (best-effort; enabled when installed) -----------------

export const copilotProvider: AgentProvider = {
  id: 'copilot',
  command: 'copilot',
  label: 'GitHub Copilot CLI',
  seedModels: ['gpt-5', 'claude-sonnet-4'],
  plan(ctx): SpawnPlan {
    const args = ['--output-format', 'json'];
    args.push(...permissionArgs('copilot', ctx.permission));
    if (ctx.model) args.push('--model', ctx.model);
    return { args, stdin: withSystem(ctx), outputFormat: 'text-tail' };
  },
  createParser: () => new TextTailParser(),
};

export const qwenProvider: AgentProvider = {
  id: 'qwen',
  command: 'qwen',
  label: 'Qwen Coder CLI',
  seedModels: ['qwen3-coder-plus'],
  plan(ctx): SpawnPlan {
    const args: string[] = [];
    args.push(...permissionArgs('qwen', ctx.permission));
    if (ctx.model) args.push('-m', ctx.model);
    args.push('-p', withSystem(ctx));
    return { args, outputFormat: 'text-tail' };
  },
  createParser: () => new TextTailParser(),
};

export const opencodeProvider: AgentProvider = {
  id: 'opencode',
  command: 'opencode',
  label: 'opencode',
  seedModels: [],
  plan(ctx): SpawnPlan {
    const args = ['run'];
    args.push(...permissionArgs('opencode', ctx.permission));
    if (ctx.model) args.push('--model', ctx.model);
    args.push(withSystem(ctx));
    return { args, outputFormat: 'text-tail' };
  },
  createParser: () => new TextTailParser(),
};

// --- model discovery helpers ----------------------------------------------

/**
 * How each CLI spells a permission mode. `null` means the CLI has no faithful
 * way to express it — and that is answered with an error rather than a quiet
 * downgrade, because the failure mode of guessing here is an agent editing a
 * repository it was supposed to be reading.
 */
type PermissionArgs = Partial<Record<PermissionMode, string[] | null>>;

const PERMISSIONS: Record<string, PermissionArgs> = {
  claude: {
    'read-only': ['--permission-mode', 'plan'],
    edit: ['--permission-mode', 'acceptEdits'],
    bypass: ['--permission-mode', 'bypassPermissions'],
  },
  codex: {
    'read-only': ['-s', 'read-only'],
    edit: ['-s', 'workspace-write'],
    bypass: ['--dangerously-bypass-approvals-and-sandbox'],
  },
  // The rest expose one all-or-nothing switch: either every tool action is
  // pre-approved or each one is prompted for, which headless cannot answer.
  // Only `bypass` is expressible; asking for anything narrower fails closed.
  gemini: { 'read-only': null, edit: null, bypass: ['-y'] },
  'cursor-agent': { 'read-only': null, edit: null, bypass: ['-f'] },
  copilot: { 'read-only': null, edit: null, bypass: ['--allow-all-tools'] },
  qwen: { 'read-only': null, edit: null, bypass: ['--yolo'] },
  opencode: { 'read-only': null, edit: null, bypass: [] },
};

/** True when this provider can honour the mode as written. */
export function supportsPermission(providerId: string, mode: PermissionMode): boolean {
  const table = PERMISSIONS[providerId];
  if (!table) return mode === 'bypass';
  return Array.isArray(table[mode]);
}

/** The argv for a mode, or a thrown error naming what could not be honoured. */
function permissionArgs(providerId: string, mode: PermissionMode): string[] {
  const args = PERMISSIONS[providerId]?.[mode];
  if (Array.isArray(args)) return args;
  throw new Error(
    `${providerId} cannot run in "${mode}" mode: it has no flag that expresses it. ` +
      `Use a provider that does (claude, codex), or --permission bypass if that is genuinely what you want.`,
  );
}

const PROBE_TIMEOUT_MS = 3000;
/** CSI/OSC escapes and stray control bytes, as emitted by a banner or spinner. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
/** A plausible model id — anything else is decoration, not a model. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;

/**
 * Stdout of a model-list probe, or null if it did not complete cleanly. A CLI
 * that cannot reach an authenticated session still writes to stdout (a sign-in
 * banner, a prompt), so only a zero exit makes that output a model list.
 */
async function probeStdout(command: string, argv: string[]): Promise<string | null> {
  const p = Bun.spawn([command, ...argv], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: { ...process.env, PATH: augmentedPath() } as Record<string, string>,
  });
  const timer = setTimeout(() => p.kill(), PROBE_TIMEOUT_MS);
  try {
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    return code === 0 ? out : null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeJsonModels(command: string, argv: string[]): Promise<string[]> {
  try {
    const out = await probeStdout(command, argv);
    if (out == null) return [];
    const data = JSON.parse(out);
    const list = Array.isArray(data) ? data : (data.models ?? data.data ?? []);
    return list.map((m: any) => (typeof m === 'string' ? m : m.id ?? m.name)).filter(Boolean);
  } catch {
    return [];
  }
}

async function probeLineModels(command: string, argv: string[]): Promise<string[]> {
  try {
    const out = await probeStdout(command, argv);
    if (out == null) return [];
    return out
      .split('\n')
      .map((l) => l.replace(ANSI_RE, '').trim())
      .filter((l) => MODEL_ID_RE.test(l));
  } catch {
    return [];
  }
}
