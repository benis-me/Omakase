import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentActivity } from '@omakase/core';
import { claudeProvider, codexProvider, geminiProvider, cursorProvider, supportsPermission } from './providers.ts';
import { getProvider, commandBase } from './registry.ts';
import { runTurn } from './runner.ts';
import { detectProviders, detectCached, loadAgentsCache } from './detect.ts';
import { GenericJsonParser, CodexJsonParser, isRateLimit } from './parsers.ts';
import { BunSpawner, type ProcessSpawner, type SpawnRequest, type SpawnResult } from './spawn.ts';
import { augmentedPath } from './env.ts';
import type { TurnContext } from './types.ts';

class FakeSpawner implements ProcessSpawner {
  captured?: SpawnRequest;
  constructor(
    private lines: string[],
    private exitCode = 0,
  ) {}
  async run(req: SpawnRequest): Promise<SpawnResult> {
    this.captured = req;
    for (const l of this.lines) req.onStdoutLine(l);
    return { exitCode: this.exitCode, stderrTail: '', timedOut: false, aborted: false, outputOverflow: false };
  }
}

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    prompt: 'do the thing',
    cwd: '/tmp/work',
    permission: 'bypass' as const,
    scratchFile: '/tmp/last.txt',
    ...overrides,
  };
}

test('claude: plan args include stream-json + session-id', () => {
  const plan = claudeProvider.plan(ctx({ plannedSessionId: 'uuid-1', model: 'sonnet', systemPrompt: 'be good' }));
  expect(plan.args).toContain('-p');
  expect(plan.args).toContain('--output-format');
  expect(plan.args).toContain('stream-json');
  expect(plan.args).toContain('--include-partial-messages');
  expect(plan.args).toEqual(expect.arrayContaining(['--session-id', 'uuid-1']));
  expect(plan.args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
  expect(plan.args).toEqual(expect.arrayContaining(['--append-system-prompt', 'be good']));
  expect(plan.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
  expect(plan.stdin).toContain('"role":"user"');
});

test('claude: resume takes precedence over session-id', () => {
  const plan = claudeProvider.plan(ctx({ plannedSessionId: 'uuid-1', resumeSessionId: 'sess-9' }));
  expect(plan.args).toEqual(expect.arrayContaining(['--resume', 'sess-9']));
  expect(plan.args).not.toContain('--session-id');
});

test('codex: plan uses exec + cwd flag + last-message file', () => {
  const plan = codexProvider.plan(ctx({ model: 'gpt-5' }));
  expect(plan.args.slice(0, 2)).toEqual(['exec', '--json']);
  expect(plan.args).toEqual(expect.arrayContaining(['-C', '/tmp/work']));
  expect(plan.args).toEqual(expect.arrayContaining(['-o', '/tmp/last.txt']));
  expect(plan.args).toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(plan.lastMessageFile).toBe('/tmp/last.txt');
  expect(plan.args[plan.args.length - 1]).toBe('do the thing');
});

test('codex: resume prepends resume subcommand', () => {
  const plan = codexProvider.plan(ctx({ resumeSessionId: 'thread-7' }));
  expect(plan.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-7']);
});

test('PATH: the active shell wins over fallback global install directories', () => {
  const parts = augmentedPath('/active/bin:/second/bin').split(':');
  expect(parts.slice(0, 3)).toEqual([dirname(process.execPath), '/active/bin', '/second/bin']);
  expect(new Set(parts).size).toBe(parts.length);
});

test('gemini: yolo + stream-json + positional prompt', () => {
  const plan = geminiProvider.plan(ctx({ systemPrompt: 'sys' }));
  expect(plan.args).toContain('-y');
  expect(plan.args).toEqual(expect.arrayContaining(['-o', 'stream-json']));
  expect(plan.args[plan.args.length - 1]).toContain('do the thing');
  expect(plan.args[plan.args.length - 1]).toContain('sys');
});

test('cursor: print + force + stream-json', () => {
  const plan = cursorProvider.plan(ctx());
  expect(plan.args).toContain('-p');
  expect(plan.args).toContain('-f');
  expect(plan.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
});

test('runTurn: cursor stream-json (Claude-compatible) yields result + session id', async () => {
  const spawner = new FakeSpawner([
    '{"type":"system","subtype":"init","session_id":"chat-7"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"working"}]},"session_id":"chat-7"}',
    '{"type":"result","subtype":"success","is_error":false,"result":"All done.","session_id":"chat-7","duration_ms":10}',
  ]);
  const res = await runTurn(cursorProvider, ctx(), { spawner, command: 'cursor-agent' });
  expect(res.status).toBe('ok');
  expect(res.text).toBe('All done.');
  expect(res.providerSessionId).toBe('chat-7'); // doubles as the resume chatId
});

test('registry: resolve by id, command, path', () => {
  expect(getProvider('claude')?.id).toBe('claude');
  expect(getProvider('/usr/local/bin/codex')?.id).toBe('codex');
  expect(commandBase('/a/b/cursor-agent.cmd')).toBe('cursor-agent');
  expect(getProvider('nope')).toBeUndefined();
});

test('runTurn: parses claude stream-json to a normalized result', async () => {
  const acts: AgentActivity[] = [];
  const spawner = new FakeSpawner([
    '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working on it"},{"type":"tool_use","name":"Write","input":{"file_path":"a.ts"}}]},"session_id":"sess-1"}',
    '{"type":"result","subtype":"success","result":"Done building.","session_id":"sess-1","is_error":false,"usage":{"input_tokens":10,"output_tokens":20},"total_cost_usd":0.0012}',
  ]);
  const res = await runTurn(claudeProvider, ctx(), { spawner, onActivity: (a) => acts.push(a), command: 'claude' });
  expect(res.status).toBe('ok');
  expect(res.text).toBe('Done building.');
  expect(res.providerSessionId).toBe('sess-1');
  expect(res.tokens).toBe(30);
  expect(res.costUsd).toBeCloseTo(0.0012);
  expect(acts.some((a) => a.tool === 'Write')).toBe(true);
});

test('runTurn: codex reads final text from last-message file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-cx-'));
  const scratch = join(dir, 'last.txt');
  writeFileSync(scratch, 'FINAL ANSWER');
  try {
    const spawner = new FakeSpawner(['{"type":"item.started","item":{"type":"command_execution","command":"bun test"}}']);
    const res = await runTurn(codexProvider, ctx({ scratchFile: scratch }), { spawner, command: 'codex' });
    expect(res.text).toBe('FINAL ANSWER');
    expect(res.status).toBe('ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTurn: non-zero exit surfaces stderr as error', async () => {
  const spawner = new FakeSpawner([], 1);
  const res = await runTurn(cursorProvider, ctx(), { spawner, command: 'cursor-agent' });
  expect(res.status).toBe('error');
});

test('runTurn: filters noise banners from the surfaced error', async () => {
  const spawner: ProcessSpawner = {
    async run(): Promise<SpawnResult> {
      return {
        exitCode: 41,
        stderrTail: 'YOLO mode is enabled. All tool calls will be automatically approved.\nError: Please set GEMINI_API_KEY',
        timedOut: false,
        aborted: false,
        outputOverflow: false,
      };
    },
  };
  const res = await runTurn(geminiProvider, ctx(), { spawner, command: 'gemini' });
  expect(res.status).toBe('error');
  expect(res.text).toContain('GEMINI_API_KEY');
  expect(res.text).not.toContain('YOLO');
});

test('GenericJsonParser: filters noise, keeps JSON result + session id', () => {
  const p = new GenericJsonParser({ sessionIdKeys: ['session_id'], finalFromFile: false, textKeys: ['text', 'content'] });
  p.onLine('YOLO mode is enabled. All tool calls will be automatically approved.');
  p.onLine('{"type":"assistant","content":"Real answer","session_id":"s1"}');
  const r = p.finalize({ exitCode: 0, stderrTail: '' });
  expect(r.text).toBe('Real answer');
  expect(r.providerSessionId).toBe('s1');
});

test('GenericJsonParser: noise-only failure leaves text empty (stderr wins in runner)', () => {
  const p = new GenericJsonParser({ sessionIdKeys: ['session_id'], finalFromFile: false, textKeys: ['text'] });
  p.onLine('YOLO mode is enabled. All tool calls will be automatically approved.');
  const r = p.finalize({ exitCode: 41, stderrTail: 'auth error' });
  expect(r.text).toBe('');
  expect(r.status).toBe('error');
});

test('CodexJsonParser: thread id + command activity + usage; -o file wins for final text', () => {
  const p = new CodexJsonParser();
  const acts = [
    ...p.onLine('{"type":"thread.started","thread_id":"th-1"}'),
    ...p.onLine('{"type":"item.completed","item":{"type":"command_execution","command":"bun test","exit_code":0}}'),
    ...p.onLine('{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"modify"}]}}'),
    ...p.onLine('{"type":"item.completed","item":{"type":"agent_message","text":"stream answer"}}'),
    ...p.onLine('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":7,"output_tokens":20}}'),
  ];
  const r = p.finalize({ exitCode: 0, stderrTail: '', lastMessageFileContent: 'FINAL FROM FILE' });
  expect(r.providerSessionId).toBe('th-1');
  expect(r.tokens).toBe(30);
  expect(r.text).toBe('FINAL FROM FILE'); // -o file is authoritative
  expect(acts.some((a) => a.tool === 'Bash')).toBe(true);
  expect(acts.some((a) => a.tool === 'Edit' && a.summary.includes('a.ts'))).toBe(true);
});

test('CodexJsonParser: cached input is already included in input tokens', () => {
  const p = new CodexJsonParser();
  p.onLine('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25,"total_tokens":125}}');
  const r = p.finalize({ exitCode: 0, stderrTail: '' });
  expect(r.tokens).toBe(125);
});

test('CodexJsonParser: started/completed updates announce one tool action', () => {
  const p = new CodexJsonParser();
  const started = p.onLine('{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"bun test"}}');
  const completed = p.onLine('{"type":"item.completed","item":{"id":"cmd-1","type":"command_execution","command":"bun test"}}');
  expect([...started, ...completed].filter((a) => a.tool === 'Bash')).toHaveLength(1);
});

test('CodexJsonParser: falls back to agent_message text when no -o file', () => {
  const p = new CodexJsonParser();
  p.onLine('{"type":"item.completed","item":{"type":"agent_message","text":"stream answer"}}');
  const r = p.finalize({ exitCode: 0, stderrTail: '' });
  expect(r.text).toBe('stream answer');
  expect(r.status).toBe('ok');
});

test('isRateLimit detects common overload/limit phrases', () => {
  expect(isRateLimit('Error: 429 Too Many Requests')).toBe(true);
  expect(isRateLimit('the model is overloaded, try again')).toBe(true);
  expect(isRateLimit('rate limit exceeded')).toBe(true);
  expect(isRateLimit('quota exhausted')).toBe(true);
  expect(isRateLimit('file not found')).toBe(false);
  expect(isRateLimit('')).toBe(false);
});

test('CodexJsonParser: error event marks the result as error', () => {
  const p = new CodexJsonParser();
  p.onLine('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"model not supported"}}');
  const r = p.finalize({ exitCode: 0, stderrTail: '' });
  expect(r.status).toBe('error');
  expect(r.text).toBe('model not supported');
});

// A fake `claude` binary: emits claude stream-json, echoes --session-id, and
// writes built.txt in its cwd. Lets us exercise the REAL spawn + parser path.
const FAKE_CLAUDE_BODY = `
const args = process.argv.slice(2);
const si = args.indexOf('--session-id');
const sessionId = si >= 0 && args[si + 1] ? args[si + 1] : 'fake-sess';
await Bun.stdin.text().catch(() => '');
await Bun.write('built.txt', 'ok');
const out = [
  { type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-1' },
  { type: 'assistant', message: { role: 'assistant', content: [ { type: 'text', text: 'Working' }, { type: 'tool_use', name: 'Write', input: { file_path: 'built.txt' } } ] }, session_id: sessionId },
  { type: 'result', subtype: 'success', result: 'Built built.txt', session_id: sessionId, is_error: false, usage: { input_tokens: 5, output_tokens: 10 }, total_cost_usd: 0.0001 },
];
process.stdout.write(out.map((o) => JSON.stringify(o)).join('\\n') + '\\n');
`;

test('runTurn: REAL spawn of a fake claude binary, parsed end-to-end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-fake-'));
  try {
    const fake = join(dir, 'fake-claude.ts');
    // Absolute interpreter path — robust across OSes/CI (no PATH lookup).
    writeFileSync(fake, `#!${process.execPath}${FAKE_CLAUDE_BODY}`);
    chmodSync(fake, 0o755);
    const work = join(dir, 'work');
    mkdirSync(work, { recursive: true });

    const res = await runTurn(
      claudeProvider,
      { prompt: 'do it', cwd: work, permission: 'bypass' as const, scratchFile: join(dir, 's.txt'), plannedSessionId: 'sess-42' },
      { command: fake },
    );
    expect(res.status).toBe('ok');
    expect(res.text).toBe('Built built.txt');
    expect(res.providerSessionId).toBe('sess-42'); // echoed from --session-id
    expect(res.tokens).toBe(15);
    expect(existsSync(join(work, 'built.txt'))).toBe(true);
    expect(res.activities.some((a) => a.tool === 'Write')).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

// Integration: actually probe the machine. Every known provider is reported
// with a boolean availability (which specific CLIs are installed varies by env,
// so we don't assert any particular one — that would fail on a clean CI runner).
test('detectProviders probes every known provider and reports availability', async () => {
  const infos = await detectProviders({ discoverModels: false });
  const byId = Object.fromEntries(infos.map((i) => [i.id, i]));
  for (const id of ['claude', 'codex', 'gemini', 'cursor-agent']) {
    expect(byId[id]).toBeDefined();
    expect(typeof byId[id]!.available).toBe('boolean');
  }
}, 15000);

/** Write an executable fake CLI; absolute interpreter path, no PATH lookup. */
function writeFakeBin(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\n${body}`);
  chmodSync(p, 0o755);
  return p;
}

// What `cursor-agent models` prints with no authenticated session: ASCII art in
// colour, then a prompt, then a non-zero exit.
const FAKE_CURSOR_BANNER_BODY = `
process.stdout.write('\\x1b[36m' + [
  '+i":;;',
  '[?+<l,",::;;;I',
  '11{[#M##M##M#########*ppll',
  '^^^O>>',
  '>>',
  'Press any key to sign in...',
].join('\\n') + '\\x1b[0m\\n');
process.exit(Number(process.env.FAKE_EXIT_CODE ?? '1'));
`;

const FAKE_CURSOR_MODELS_BODY = `
process.stdout.write('\\x1b[1mgpt-5\\x1b[0m\\n\\nsonnet-4\\n  \\u2500\\u2500\\u2500\\u2500  \\nsonnet-4-thinking\\n');
`;

test('codex: model discovery reads the catalog slug field', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-models-'));
  try {
    const fake = writeFakeBin(
      dir,
      'fake-codex-models.ts',
      `process.stdout.write(JSON.stringify({models:[{slug:'gpt-new'},{slug:'gpt-mini'}]}));`,
    );
    expect(await codexProvider.discoverModels!(fake)).toEqual(['gpt-new', 'gpt-mini']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cursor: a sign-in banner with a non-zero exit yields no models', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-models-'));
  try {
    const fake = writeFakeBin(dir, 'fake-cursor-banner.ts', FAKE_CURSOR_BANNER_BODY);
    expect(await cursorProvider.discoverModels!(fake)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('cursor: banner decoration is rejected even on a clean exit; real ids survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-models-'));
  try {
    const banner = writeFakeBin(dir, 'fake-cursor-ok-banner.ts', FAKE_CURSOR_BANNER_BODY);
    process.env.FAKE_EXIT_CODE = '0';
    try {
      expect(await cursorProvider.discoverModels!(banner)).toEqual([]);
    } finally {
      delete process.env.FAKE_EXIT_CODE;
    }
    const list = writeFakeBin(dir, 'fake-cursor-models.ts', FAKE_CURSOR_MODELS_BODY);
    expect(await cursorProvider.discoverModels!(list)).toEqual(['gpt-5', 'sonnet-4', 'sonnet-4-thinking']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

// --- agents cache TTL ------------------------------------------------------

function writeCache(dir: string, scannedAt: number): string {
  const p = join(dir, 'agents.json');
  const providers = [
    { id: 'ghost-agent', command: 'ghost-agent', label: 'Ghost', available: true, version: '1.0', path: '/bin/ghost', models: ['g-1'] },
  ];
  writeFileSync(p, JSON.stringify({ scannedAt, providers }, null, 2) + '\n');
  return p;
}

test('loadAgentsCache honours scannedAt: fresh is served, expired is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-cache-'));
  try {
    const fresh = loadAgentsCache(writeCache(dir, Date.now() - 60_000));
    expect(fresh?.map((p) => p.id)).toEqual(['ghost-agent']);

    const stale = loadAgentsCache(writeCache(dir, Date.now() - 25 * 60 * 60 * 1000));
    expect(stale).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stale cache must not be served: it decides which providers exist, and
// Runtime.selectProvider silently reroutes to another one when the requested
// provider is missing from it.
test('detectCached rescans past the TTL instead of serving a stale provider list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-cache-'));
  try {
    const path = writeCache(dir, Date.now() - 25 * 60 * 60 * 1000);
    const rescanned = await detectCached(path, { discoverModels: false });
    expect(rescanned.some((p) => p.id === 'ghost-agent')).toBe(false);
    expect(rescanned.some((p) => p.id === 'claude')).toBe(true); // a real scan of the registry

    const path2 = writeCache(dir, Date.now() - 60_000);
    const cached = await detectCached(path2, { discoverModels: false });
    expect(cached.map((p) => p.id)).toEqual(['ghost-agent']); // still cheap within the TTL
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

// --- stderr decoding -------------------------------------------------------

// Splits a 3-byte '…' across two stderr writes, which land as separate chunks.
const FAKE_SPLIT_STDERR_BODY = `
const b = Buffer.from('Error: timed out \\u2026 retry\\n', 'utf8');
const cut = b.indexOf(0xe2) + 1;
process.stderr.write(b.subarray(0, cut));
setTimeout(() => process.stderr.write(b.subarray(cut)), 50);
setTimeout(() => process.exit(3), 100);
`;

test('BunSpawner: a multi-byte character split across stderr chunks is not corrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-stderr-'));
  try {
    const fake = writeFakeBin(dir, 'fake-split-stderr.ts', FAKE_SPLIT_STDERR_BODY);
    const chunks: string[] = [];
    const res = await new BunSpawner().run({
      command: fake,
      args: [],
      cwd: dir,
      env: process.env as Record<string, string>,
      onStdoutLine: () => {},
      onStderrChunk: (c) => chunks.push(c),
      timeoutMs: 10_000,
      maxStdoutBytes: 1 << 20,
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderrTail).toBe('Error: timed out … retry\n');
    expect(res.stderrTail).not.toContain('�');
    expect(chunks.join('')).toBe('Error: timed out … retry\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('permission: each mode maps to the provider’s own native flags', () => {
  const ctx = (permission: 'read-only' | 'edit' | 'bypass') => ({
    prompt: 'p', cwd: '/tmp', permission, scratchFile: '/tmp/s.txt',
  }) as never;

  // claude and codex can express all three, in their own vocabularies.
  expect(claudeProvider.plan(ctx('read-only')).args).toContain('plan');
  expect(claudeProvider.plan(ctx('edit')).args).toContain('acceptEdits');
  expect(claudeProvider.plan(ctx('bypass')).args).toContain('bypassPermissions');
  expect(codexProvider.plan(ctx('read-only')).args.join(' ')).toContain('-s read-only');
  expect(codexProvider.plan(ctx('edit')).args.join(' ')).toContain('-s workspace-write');
  expect(codexProvider.plan(ctx('bypass')).args).toContain('--dangerously-bypass-approvals-and-sandbox');
});

test('permission: a provider that cannot express a mode refuses the run', () => {
  const ctx = (permission: 'read-only' | 'edit' | 'bypass') => ({
    prompt: 'p', cwd: '/tmp', permission, scratchFile: '/tmp/s.txt',
  }) as never;

  // gemini has one all-or-nothing switch. Asking it to look-but-not-touch must
  // fail loudly: silently running it with write access is the one outcome that
  // would make the request a lie.
  expect(() => geminiProvider.plan(ctx('read-only'))).toThrow(/cannot run in "read-only"/);
  expect(() => geminiProvider.plan(ctx('edit'))).toThrow(/cannot run in "edit"/);
  expect(geminiProvider.plan(ctx('bypass')).args).toContain('-y');

  expect(supportsPermission('claude', 'read-only')).toBe(true);
  expect(supportsPermission('codex', 'read-only')).toBe(true);
  expect(supportsPermission('gemini', 'read-only')).toBe(false);
  expect(supportsPermission('cursor-agent', 'read-only')).toBe(false);
});
