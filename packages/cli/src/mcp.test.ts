import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { Harness, HarnessRequest, HarnessResult } from '@omakase/engine';
import type { ProviderInfo } from '@omakase/providers';
import { McpServer } from './mcp.ts';

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
