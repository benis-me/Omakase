import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { Harness, HarnessRequest, HarnessResult } from '@omakase/engine';
import type { ProviderInfo } from '@omakase/providers';
import { McpServer } from './mcp.ts';
import { cmdWorkflow } from './commands/workflow.ts';

class FakeHarness implements Harness {
  readonly id = 'fake';
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    return { text: 'ok', status: 'ok', sessionId: 's', tokens: 1, costUsd: 0, activities: [], durationMs: 1, provider: req.provider };
  }
  async listProviders(): Promise<ProviderInfo[]> {
    return [{ id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/c', models: [] }];
  }
}

function ctx() {
  const dir = mkdtempSync(join(tmpdir(), 'omks-mcp-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  return { server: new McpServer({ workspace: ws, store, harness: new FakeHarness() }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('mcp: initialize returns serverInfo + tools capability', async () => {
  const { server, cleanup } = ctx();
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  expect(res?.result).toMatchObject({ serverInfo: { name: 'omakase' }, capabilities: { tools: {} } });
  cleanup();
});

test('mcp: tools/list exposes the omakase tools', async () => {
  const { server, cleanup } = ctx();
  const res = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = (res!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  expect(names).toContain('omakase_run_goal');
  expect(names).toContain('omakase_list_workflows');
  expect(names).toContain('omakase_get_run');
  cleanup();
});

test('mcp: tools/call list_workflows returns built-ins', async () => {
  const { server, cleanup } = ctx();
  const res = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omakase_list_workflows', arguments: {} } });
  const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
  expect(text).toContain('goal');
  expect(text).toContain('auto');
  cleanup();
});

test('mcp: tools/call run_goal executes via the engine', async () => {
  const { server, cleanup } = ctx();
  const res = await server.handle({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'omakase_run_goal', arguments: { goal: 'do it', workflow: 'solo' } },
  });
  const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
  expect(text).toContain('succeeded');
  cleanup();
});

test('mcp: notifications receive no reply', async () => {
  const { server, cleanup } = ctx();
  expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  cleanup();
});

test('mcp: unknown method → -32601', async () => {
  const { server, cleanup } = ctx();
  const res = await server.handle({ jsonrpc: '2.0', id: 5, method: 'bogus/method' });
  expect(res?.error?.code).toBe(-32601);
  cleanup();
});

// --- stdio loop: a long tool call must not stall the reader ------------------

/** A harness that parks in runAgent until released — stands in for a minutes-long agent CLI. */
class SlowHarness implements Harness {
  readonly id = 'slow';
  calls = 0;
  constructor(private gate: Promise<void>) {}
  async runAgent(req: HarnessRequest): Promise<HarnessResult> {
    this.calls++;
    await new Promise<void>((resolve) => {
      void this.gate.then(resolve);
      req.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (req.signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    return { text: 'ok', status: 'ok', sessionId: 's', tokens: 1, costUsd: 0, activities: [], durationMs: 1, provider: req.provider };
  }
  async listProviders(): Promise<ProviderInfo[]> {
    return [{ id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/c', models: [] }];
  }
}

function slowCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'omks-mcp-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  let release!: () => void;
  const harness = new SlowHarness(new Promise<void>((r) => (release = r)));
  return { server: new McpServer({ workspace: ws, store, harness }), harness, release, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A writable stdin stand-in, so a request can be delivered in a later chunk. */
function pipe() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  return {
    stream,
    send: (req: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(req) + '\n')),
    end: () => ctrl.close(),
  };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await Bun.sleep(5);
}

const callGoal = (id: number) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name: 'omakase_run_goal', arguments: { goal: 'do it', workflow: 'solo' } },
});
const textOf = (res: { result?: unknown } | undefined) => ((res?.result as { content?: { text: string }[] })?.content?.[0]?.text ?? '');

test('mcp: a second request is answered while a slow tool call is still in flight', async () => {
  const { server, harness, release, cleanup } = slowCtx();
  const got: { id?: number | string | null }[] = [];
  const io = pipe();
  const done = server.serve(io.stream, (res) => void got.push(res));

  io.send(callGoal(1));
  await until(() => harness.calls > 0);
  expect(harness.calls).toBe(1); // the tool call is genuinely parked in the harness

  io.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  await until(() => got.length > 0);
  expect(got.map((r) => r.id)).toEqual([2]); // answered without waiting for run_goal

  release();
  io.end();
  await done;
  expect(got.map((r) => r.id)).toEqual([2, 1]);
  cleanup();
});

test('mcp: notifications/cancelled aborts the tool call it names', async () => {
  const { server, harness, release, cleanup } = slowCtx();
  const got: { id?: number | string | null; result?: unknown }[] = [];
  const io = pipe();
  const done = server.serve(io.stream, (res) => void got.push(res));

  io.send(callGoal(1));
  await until(() => harness.calls > 0);

  // Never released — only the cancellation can unblock the run.
  io.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  await until(() => got.length > 0);
  const first = got[0];

  release();
  io.end();
  await done;
  expect(first?.id).toBe(1);
  expect(textOf(first)).toContain('cancelled');
  cleanup();
});

// --- workflow version --------------------------------------------------------

function workflowCtx(version: string) {
  const dir = mkdtempSync(join(tmpdir(), 'omks-wf-'));
  const ws = Workspace.init(dir);
  const entry = join(ws.paths.workflows, 'myflow.ts');
  writeFileSync(
    entry,
    `// name: myflow\n// description: A test workflow.\n// version: ${version}\nexport default async function myflow(): Promise<void> {}\n`,
  );
  const prev = process.cwd();
  process.chdir(dir);
  return {
    entry,
    cleanup: () => {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('workflow version: an unrecognised --bump errors instead of silently patch-bumping', async () => {
  const { entry, cleanup } = workflowCtx('1.2.3');
  // bumpVersion treats anything that isn't major/minor as a patch, so `majro`
  // would otherwise report success and persist v1.2.4.
  expect(await cmdWorkflow(['version', 'myflow', '--bump', 'majro'])).toBe(1);
  expect(readFileSync(entry, 'utf8')).toContain('// version: 1.2.3');
  cleanup();
});

test('workflow version: valid --bump values still bump', async () => {
  const { entry, cleanup } = workflowCtx('1.2.3');
  expect(await cmdWorkflow(['version', 'myflow', '--bump', 'major'])).toBe(0);
  expect(readFileSync(entry, 'utf8')).toContain('// version: 2.0.0');
  cleanup();
});

test('workflow version: bare --bump shows the version rather than erroring', async () => {
  const { entry, cleanup } = workflowCtx('1.2.3');
  expect(await cmdWorkflow(['version', 'myflow', '--bump'])).toBe(0);
  expect(readFileSync(entry, 'utf8')).toContain('// version: 1.2.3');
  cleanup();
});
