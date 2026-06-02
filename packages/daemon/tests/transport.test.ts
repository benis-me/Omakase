import { describe, expect, it } from 'vitest';
import { AgentSpawnError } from '../src/runtime/errors.js';
import { createNodeTransport } from '../src/runtime/transport.js';
import {
  createFakeTransport,
  drain,
  scriptedTransport,
} from '../src/testing/index.js';

const node = process.execPath;

describe('fake transport', () => {
  it('records spawn requests and scripts stdout/exit', async () => {
    const transport = scriptedTransport({ stdout: ['line-1', 'line-2'], exitCode: 0 });
    const proc = transport.spawn({ command: 'demo', args: ['--flag'] });
    const out = (await drain(proc.stdout)).join('');
    const exit = await proc.wait();
    expect(out).toBe('line-1\nline-2\n');
    expect(exit.code).toBe(0);
    expect(transport.calls[0]).toMatchObject({ command: 'demo', args: ['--flag'] });
  });

  it('lets a handler react to stdin (interactive protocols)', async () => {
    const transport = createFakeTransport((ctrl) => {
      ctrl.onStdin((data) => {
        const parsed = JSON.parse(data.trim()) as { echo: string };
        ctrl.emitStdoutJson({ reply: parsed.echo.toUpperCase() });
        ctrl.exit(0);
      });
    });
    const proc = transport.spawn({ command: 'iface', args: [] });
    proc.writeStdin(`${JSON.stringify({ echo: 'hi' })}\n`);
    const out = (await drain(proc.stdout)).join('');
    await proc.wait();
    expect(JSON.parse(out.trim())).toEqual({ reply: 'HI' });
  });

  it('simulates a spawn failure', async () => {
    const transport = createFakeTransport((ctrl) => {
      ctrl.failSpawn(new AgentSpawnError('ENOENT: no such binary'));
    });
    const proc = transport.spawn({ command: 'ghost', args: [] });
    await expect(proc.wait()).rejects.toBeInstanceOf(AgentSpawnError);
  });
});

describe('node transport', () => {
  it('streams stdout and resolves the exit code', async () => {
    const transport = createNodeTransport();
    const proc = transport.spawn({
      command: node,
      args: ['-e', 'process.stdout.write("a\\nb\\n"); process.exit(0)'],
    });
    const out = (await drain(proc.stdout)).join('');
    const exit = await proc.wait();
    expect(out).toBe('a\nb\n');
    expect(exit.code).toBe(0);
  });

  it('rejects wait() with AgentSpawnError on ENOENT', async () => {
    const transport = createNodeTransport();
    const proc = transport.spawn({
      command: 'omakase-nonexistent-binary-xyz',
      args: [],
    });
    await expect(proc.wait()).rejects.toBeInstanceOf(AgentSpawnError);
  });

  it('terminates the process when the abort signal fires', async () => {
    const transport = createNodeTransport();
    const controller = new AbortController();
    const proc = transport.spawn({
      command: node,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    });
    controller.abort();
    const exit = await proc.wait();
    expect(exit.signal).toBe('SIGTERM');
    expect(exit.code).toBeNull();
  });
});
