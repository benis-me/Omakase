import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentActivity } from '@omakase/core';
import { claudeProvider, codexProvider, geminiProvider, cursorProvider } from './providers.ts';
import { getProvider, commandBase } from './registry.ts';
import { runTurn } from './runner.ts';
import { detectProviders } from './detect.ts';
import { GenericJsonParser, CodexJsonParser, isRateLimit } from './parsers.ts';
import type { ProcessSpawner, SpawnRequest, SpawnResult } from './spawn.ts';
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
    autoApprove: true,
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
    ...p.onLine('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":20}}'),
  ];
  const r = p.finalize({ exitCode: 0, stderrTail: '', lastMessageFileContent: 'FINAL FROM FILE' });
  expect(r.providerSessionId).toBe('th-1');
  expect(r.tokens).toBe(30);
  expect(r.text).toBe('FINAL FROM FILE'); // -o file is authoritative
  expect(acts.some((a) => a.tool === 'Bash')).toBe(true);
  expect(acts.some((a) => a.tool === 'Edit' && a.summary.includes('a.ts'))).toBe(true);
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
  p.onLine('{"type":"error","message":"boom"}');
  const r = p.finalize({ exitCode: 0, stderrTail: '' });
  expect(r.status).toBe('error');
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
      { prompt: 'do it', cwd: work, autoApprove: true, scratchFile: join(dir, 's.txt'), plannedSessionId: 'sess-42' },
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
