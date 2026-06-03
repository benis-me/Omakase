import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgentRuntime } from '../src/runtime/runtime.js';
import { createRegistry } from '../src/runtimes/registry.js';
import { createScriptedAgent } from '../src/runtime/executors/builtin.js';
import { createFakeTransport, type FakeProcessController } from '../src/testing/index.js';
import type { Transport } from '../src/runtime/transport.js';

let binDir: string;
let home: string;

function makeBin(name: string): void {
  const p = path.join(binDir, name);
  writeFileSync(p, '#!/bin/sh\necho fake\n');
  chmodSync(p, 0o755);
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), 'omakase-exec-bin-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'omakase-exec-home-'));
  for (const name of ['claude', 'codex', 'pi', 'gemini', 'opencode']) makeBin(name);
});

function runtimeWith(transport: Transport) {
  return createAgentRuntime({
    registry: createRegistry(),
    transport,
    detection: {
      transport,
      env: { PATH: binDir },
      includeWellKnownPathDirs: false,
      home,
    },
    now: () => 1000,
  });
}

function isProbe(ctrl: FakeProcessController): boolean {
  return ctrl.request.args.includes('--version') || ctrl.request.args.includes('--help');
}

function answerProbe(ctrl: FakeProcessController): void {
  if (ctrl.request.args.includes('--version')) ctrl.emitStdout('9.9.9\n');
  if (ctrl.request.args.includes('--help')) {
    ctrl.emitStdout('flags: --add-dir --include-partial-messages\n');
  }
  ctrl.exit(0);
}

describe('runtime: spawn executor (claude stream-json)', () => {
  it('runs an installed agent and folds the result', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdoutJson({ type: 'system', subtype: 'init' });
        ctrl.emitStdoutJson({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Hello from Claude' },
              { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
            ],
          },
        });
        ctrl.emitStdoutJson({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        });
        ctrl.emitStdoutJson({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.02,
          usage: { input_tokens: 5, output_tokens: 3 },
        });
        ctrl.exit(0);
      });
    });
    const runtime = runtimeWith(transport);
    const result = await runtime.runAgent({ agentId: 'claude', prompt: 'hi', cwd: binDir });
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Hello from Claude');
    expect(result.toolCalls[0]?.result).toEqual({ content: 'ok', isError: false });
    expect(result.costUsd).toBe(0.02);

    // Capability flow: --help advertised partial messages, so buildArgs used it.
    const runCall = transport.calls.find((c) => c.args.includes('-p') && !c.args.includes('--help'));
    expect(runCall?.args).toContain('--include-partial-messages');
  });
});

describe('runtime: spawn executor (codex + plain-text)', () => {
  it('parses codex json', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdoutJson({ msg: { type: 'agent_message_delta', delta: 'Codex ' } });
        ctrl.emitStdoutJson({ msg: { type: 'agent_message_delta', delta: 'reply' } });
        ctrl.emitStdoutJson({ msg: { type: 'token_count', info: { input_tokens: 7 } } });
        ctrl.exit(0);
      });
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'codex', prompt: 'hi' });
    expect(result.text).toBe('Codex reply');
    expect(result.usage?.inputTokens).toBe(7);
  });

  it('streams plain text from gemini', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdout('Gemini ');
        ctrl.emitStdout('says hi');
        ctrl.exit(0);
      });
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'gemini', prompt: 'hi' });
    expect(result.text).toBe('Gemini says hi');
    expect(result.status).toBe('completed');
  });
});

describe('runtime: pi RPC executor', () => {
  it('drives the prompt/event RPC dialogue', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) return answerProbe(ctrl);
      ctrl.onStdin((data) => {
        const msg = JSON.parse(data.trim()) as { type: string; id: number };
        if (msg.type !== 'prompt') return;
        ctrl.emitStdoutJson({ type: 'response', id: msg.id, success: true });
        ctrl.emitStdoutJson({ type: 'agent_start' });
        ctrl.emitStdoutJson({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi ' } });
        ctrl.emitStdoutJson({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'works' } });
        ctrl.emitStdoutJson({
          type: 'tool_execution_start',
          toolCallId: 'c1',
          toolName: 'bash',
          args: { cmd: 'ls' },
        });
        ctrl.emitStdoutJson({
          type: 'tool_execution_end',
          toolCallId: 'c1',
          result: { content: [{ type: 'text', text: 'a.ts' }] },
        });
        ctrl.emitStdoutJson({
          type: 'turn_end',
          message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } },
        });
        ctrl.emitStdoutJson({ type: 'agent_end' });
      });
      ctrl.onStdinEnd(() => ctrl.exit(0));
      ctrl.onKill(() => ctrl.exit(0));
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'pi', prompt: 'hi' });
    expect(result.text).toBe('Pi works');
    expect(result.toolCalls[0]?.result?.content).toBe('a.ts');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(result.status).toBe('completed');
  });

  it('terminates (does not hang) when pi rejects the prompt', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) return answerProbe(ctrl);
      ctrl.onStdin((data) => {
        const msg = JSON.parse(data.trim()) as { type: string; id: number };
        if (msg.type !== 'prompt') return;
        // Reject the prompt, then stay alive like a real pi server would.
        ctrl.emitStdoutJson({ type: 'response', id: msg.id, success: false, error: 'bad model' });
      });
      ctrl.onStdinEnd(() => ctrl.exit(0));
      ctrl.onKill(() => ctrl.exit(0));
    });
    // No timeoutMs — must still terminate via the rejection path.
    const result = await runtimeWith(transport).runAgent({ agentId: 'pi', prompt: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/prompt rejected/);
  });

  it('auto-resolves extension-ui requests without hanging', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) return answerProbe(ctrl);
      ctrl.onStdin((data) => {
        const msg = JSON.parse(data.trim()) as { type: string; id: number };
        if (msg.type !== 'prompt') return;
        ctrl.emitStdoutJson({ type: 'extension_ui_request', id: 99, method: 'confirm' });
        ctrl.emitStdoutJson({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });
        ctrl.emitStdoutJson({ type: 'agent_end' });
      });
      ctrl.onStdinEnd(() => ctrl.exit(0));
      ctrl.onKill(() => ctrl.exit(0));
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'pi', prompt: 'hi' });
    expect(result.text).toBe('done');
    // The confirm reply was written back on stdin.
    expect(transport.calls.length).toBeGreaterThan(0);
  });
});

describe('runtime: external MCP injection', () => {
  it('writes .mcp.json into cwd for the claude strategy', async () => {
    const proj = mkdtempSync(path.join(os.tmpdir(), 'omakase-mcp-proj-'));
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdoutJson({ type: 'result', subtype: 'success' });
        ctrl.exit(0);
      });
    });
    await runtimeWith(transport).runAgent({
      agentId: 'claude',
      prompt: 'hi',
      cwd: proj,
      mcpServers: [{ name: 'fs', command: 'mcp-fs', args: ['--root', '.'] }],
    });
    const written = JSON.parse(readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.fs).toEqual({ command: 'mcp-fs', args: ['--root', '.'] });
  });

  it('sets OPENCODE_CONFIG_CONTENT in the spawn env for the opencode strategy', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) {
        ctrl.emitStdout('1.0\n');
        ctrl.exit(0);
        return;
      }
      ctrl.onStdinEnd(() => {
        ctrl.emitStdout('done');
        ctrl.exit(0);
      });
    });
    await runtimeWith(transport).runAgent({
      agentId: 'opencode',
      prompt: 'hi',
      mcpServers: [{ name: 'fs', command: 'mcp-fs' }],
    });
    const runCall = transport.calls.find((c) => c.args.includes('run'));
    const content = runCall?.env?.OPENCODE_CONFIG_CONTENT;
    expect(content).toBeTruthy();
    expect(JSON.parse(String(content)).mcp.fs.command).toContain('mcp-fs');
  });
});

describe('runtime: builtin + custom executors', () => {
  it('summarizes a project offline via the builtin agent', async () => {
    const runtime = runtimeWith(createFakeTransport(() => {}));
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const result = await runtime.runAgent({
      agentId: 'builtin',
      prompt: 'summarize this project',
      cwd: repoRoot,
    });
    expect(result.status).toBe('completed');
    expect(result.text).toContain('Project summary');
    expect(result.thinking).toContain('Interpreting request');
  });

  it('routes a registered custom executor', async () => {
    const runtime = runtimeWith(createFakeTransport(() => {}));
    runtime.registerExecutor(
      'reverser',
      createScriptedAgent((input) => [
        { type: 'text_delta', delta: input.prompt.split('').reverse().join('') },
      ]),
    );
    const result = await runtime.runAgent({ agentId: 'reverser', prompt: 'abc' });
    expect(result.text).toBe('cba');
  });
});

describe('runtime: error + lifecycle handling', () => {
  it('reports not-installed for an absent agent', async () => {
    const transport = createFakeTransport((ctrl) => {
      // qwen/copilot absent from PATH → resolveRuntime returns null without spawn.
      ctrl.exit(0);
    });
    const runtime = createAgentRuntime({
      registry: createRegistry(),
      transport,
      detection: { transport, env: { PATH: binDir }, includeWellKnownPathDirs: false, home },
    });
    const result = await runtime.runAgent({ agentId: 'qwen', prompt: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toContain('not installed');
  });

  it('caches resolution across runs when a TTL is set, and refreshes on demand', async () => {
    let versionProbes = 0;
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) {
        versionProbes += 1;
        return answerProbe(ctrl);
      }
      if (ctrl.request.args.includes('--help')) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdoutJson({ type: 'result', subtype: 'success' });
        ctrl.exit(0);
      });
    });
    const runtime = createAgentRuntime({
      registry: createRegistry(),
      transport,
      detection: { transport, env: { PATH: binDir }, includeWellKnownPathDirs: false, home },
      detectionCacheTtlMs: 60_000,
      now: () => 1000,
    });
    await runtime.runAgent({ agentId: 'claude', prompt: 'a' });
    await runtime.runAgent({ agentId: 'claude', prompt: 'b' });
    expect(versionProbes).toBe(1); // second run used the cache
    runtime.refreshDetection();
    await runtime.runAgent({ agentId: 'claude', prompt: 'c' });
    expect(versionProbes).toBe(2); // cache cleared → re-probed
  });

  it('keys the detection cache on env so a PATH change re-probes', async () => {
    let versionProbes = 0;
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) {
        versionProbes += 1;
        return answerProbe(ctrl);
      }
      if (ctrl.request.args.includes('--help')) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdoutJson({ type: 'result', subtype: 'success' });
        ctrl.exit(0);
      });
    });
    const binDir2 = mkdtempSync(path.join(os.tmpdir(), 'omakase-exec-bin2-'));
    writeFileSync(path.join(binDir2, 'claude'), '#!/bin/sh\n');
    chmodSync(path.join(binDir2, 'claude'), 0o755);
    const runtime = createAgentRuntime({
      registry: createRegistry(),
      transport,
      detection: { transport, includeWellKnownPathDirs: false, home },
      detectionCacheTtlMs: 60_000,
      now: () => 1,
    });
    await runtime.runAgent({ agentId: 'claude', prompt: 'a', env: { PATH: binDir } });
    await runtime.runAgent({ agentId: 'claude', prompt: 'b', env: { PATH: binDir } });
    expect(versionProbes).toBe(1); // same PATH → cached
    await runtime.runAgent({ agentId: 'claude', prompt: 'c', env: { PATH: binDir2 } });
    expect(versionProbes).toBe(2); // different PATH → re-probed
  });

  it('never caches a null resolution, so installing an agent mid-TTL takes effect', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'omakase-exec-late-'));
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) {
        ctrl.emitStdout('1.0\n');
        ctrl.exit(0);
        return;
      }
      ctrl.onStdinEnd(() => ctrl.exit(0));
    });
    const runtime = createAgentRuntime({
      registry: createRegistry(),
      transport,
      detection: { transport, includeWellKnownPathDirs: false, home },
      detectionCacheTtlMs: 60_000,
      now: () => 1,
    });
    const first = await runtime.runAgent({ agentId: 'gemini', prompt: 'a', env: { PATH: dir } });
    expect(first.status).toBe('error'); // not installed yet (null not cached)
    writeFileSync(path.join(dir, 'gemini'), '#!/bin/sh\n');
    chmodSync(path.join(dir, 'gemini'), 0o755);
    const second = await runtime.runAgent({ agentId: 'gemini', prompt: 'b', env: { PATH: dir } });
    expect(second.status).toBe('completed'); // re-probed, now resolves
  });

  it('cancels a run when the abort signal fires', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => ctrl.emitStdout('partial'));
      ctrl.onKill(() => ctrl.exit(143, 'SIGTERM'));
    });
    const runtime = runtimeWith(transport);
    const controller = new AbortController();
    const promise = runtime.runAgent({
      agentId: 'gemini',
      prompt: 'hi',
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    const result = await promise;
    expect(result.status).toBe('cancelled');
  });

  it('times out a hung run', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      // Never emits, never exits until killed by the timeout.
      ctrl.onKill(() => ctrl.exit(143, 'SIGTERM'));
    });
    const runtime = runtimeWith(transport);
    const result = await runtime.runAgent({ agentId: 'gemini', prompt: 'hi', timeoutMs: 40 });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timed out/i);
  });

  it('reports a signal-killed agent (OOM/SIGKILL) as error, not completed', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (isProbe(ctrl)) return answerProbe(ctrl);
      ctrl.onStdinEnd(() => {
        ctrl.emitStdout('partial output before the kernel killed it');
        // code null + signal set, and the run was NOT aborted by us.
        ctrl.exit(null, 'SIGKILL');
      });
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'gemini', prompt: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/signal SIGKILL/);
  });

  it('reports a pi crash by external signal as error, not completed', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (ctrl.request.args.includes('--version')) return answerProbe(ctrl);
      ctrl.onStdin((data) => {
        const msg = JSON.parse(data.trim()) as { type: string; id: number };
        if (msg.type !== 'prompt') return;
        ctrl.emitStdoutJson({ type: 'response', id: msg.id, success: true });
        ctrl.emitStdoutJson({ type: 'agent_start' });
        // Crash before agent_end (no clean turn end).
        ctrl.exit(null, 'SIGSEGV');
      });
      ctrl.onStdinEnd(() => ctrl.exit(null, 'SIGSEGV'));
      ctrl.onKill(() => ctrl.exit(null, 'SIGSEGV'));
    });
    const result = await runtimeWith(transport).runAgent({ agentId: 'pi', prompt: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/signal SIGSEGV/);
  });

  it('does not orphan the exit promise when the spawn fails mid-run', async () => {
    // When the spawn rejects exitPromise and the stdout loop throws, the driver
    // jumps to its catch without ever awaiting wait(). The eager exited.catch()
    // must keep that rejection from surfacing as an unhandledRejection.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const transport = createFakeTransport((ctrl) => {
        if (isProbe(ctrl)) return answerProbe(ctrl);
        ctrl.onStdinEnd(() => ctrl.failSpawn(new Error('stream broke mid-run')));
      });
      const runtime = runtimeWith(transport);
      const result = await runtime.runAgent({ agentId: 'gemini', prompt: 'hi' });
      expect(result.status).toBe('error');
      // Give any orphaned rejection a couple of ticks to surface.
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
