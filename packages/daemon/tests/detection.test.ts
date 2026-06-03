import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectAgent, detectAgents } from '../src/runtimes/detection.js';
import { AgentSpawnError } from '../src/runtime/errors.js';
import { resolveExecutable } from '../src/runtimes/executables.js';
import { createRegistry, RuntimeRegistry } from '../src/runtimes/registry.js';
import { claudeAgentDef } from '../src/runtimes/defs/claude.js';
import type { RuntimeAgentDef } from '../src/runtimes/types.js';
import type { SpawnRequest, Transport } from '../src/runtime/transport.js';
import { createFakeTransport } from '../src/testing/index.js';

let binDir: string;
let emptyHome: string;

function makeBin(name: string): string {
  const p = path.join(binDir, name);
  writeFileSync(p, '#!/bin/sh\necho fake\n');
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(os.tmpdir(), 'omakase-bin-'));
  emptyHome = mkdtempSync(path.join(os.tmpdir(), 'omakase-home-'));
  makeBin('claude');
  makeBin('codex');
  makeBin('pi');
  // gemini/opencode/cursor-agent/qwen/copilot intentionally absent.
});

afterAll(() => {
  // Temp dirs under os.tmpdir() are reclaimed by the OS; nothing to do.
});

/** A fake transport that answers probe spawns based on command + args. */
function probeTransport(): Transport {
  return createFakeTransport((ctrl) => {
    const name = path.basename(ctrl.request.command);
    const args = ctrl.request.args.join(' ');
    const emit = (out: { stdout?: string; stderr?: string; code?: number }): void => {
      if (out.stdout) ctrl.emitStdout(out.stdout);
      if (out.stderr) ctrl.emitStderr(out.stderr);
      ctrl.exit(out.code ?? 0);
    };
    if (name === 'claude') {
      if (args === '--version') return emit({ stdout: '1.2.3 (Claude Code)\n' });
      if (ctrl.request.args.includes('--help')) {
        return emit({ stdout: 'flags: --add-dir --include-partial-messages\n' });
      }
    }
    if (name === 'codex') {
      if (args === '--version') return emit({ stdout: 'codex 0.9\n' });
      if (args === 'debug models') {
        return emit({
          stdout: JSON.stringify({ models: [{ slug: 'gpt-5' }, { slug: 'o3' }] }),
        });
      }
    }
    if (name === 'pi') {
      if (args === '--version') return emit({ stdout: 'pi 2.0\n' });
      if (args === '--list-models') {
        return emit({
          stderr:
            'provider model context\nanthropic claude-sonnet-4-5 200K\nopenai gpt-5 400K\n',
        });
      }
    }
    return emit({ stdout: '', code: 0 });
  });
}

function detectOpts(extra: Record<string, unknown> = {}) {
  return {
    transport: probeTransport(),
    env: { PATH: binDir },
    includeWellKnownPathDirs: false,
    home: emptyHome,
    ...extra,
  };
}

describe('resolveExecutable', () => {
  it('finds a binary on the scoped PATH', () => {
    const r = resolveExecutable(claudeAgentDef, {
      env: { PATH: binDir },
      pathDirs: [binDir],
      home: emptyHome,
    });
    expect(r.source).toBe('path');
    expect(r.selectedPath).toBe(path.join(binDir, 'claude'));
  });

  it('honours the binEnvVar override over PATH', () => {
    const override = makeBin('claude-override');
    const r = resolveExecutable(claudeAgentDef, {
      env: { PATH: binDir, CLAUDE_BIN: override },
      pathDirs: [binDir],
      home: emptyHome,
    });
    expect(r.source).toBe('env-override');
    expect(r.selectedPath).toBe(override);
  });

  it('returns null when nothing resolves', () => {
    const r = resolveExecutable(
      { bin: 'totally-absent-bin' },
      { env: {}, pathDirs: [binDir], home: emptyHome },
    );
    expect(r.selectedPath).toBeNull();
  });

  it('falls back through fallbackBins', () => {
    makeBin('openclaude');
    const r = resolveExecutable(
      { bin: 'nope', fallbackBins: ['openclaude'] },
      { env: {}, pathDirs: [binDir], home: emptyHome },
    );
    expect(r.selectedPath).toBe(path.join(binDir, 'openclaude'));
  });
});

describe('detectAgents', () => {
  it('marks present agents available and absent agents unavailable', async () => {
    const registry = createRegistry();
    const agents = await detectAgents(registry, detectOpts());
    const byId = new Map(agents.map((a) => [a.id, a]));

    expect(byId.get('claude')?.available).toBe(true);
    expect(byId.get('claude')?.version).toBe('1.2.3 (Claude Code)');
    expect(byId.get('codex')?.available).toBe(true);
    expect(byId.get('pi')?.available).toBe(true);

    expect(byId.get('gemini')?.available).toBe(false);
    expect(byId.get('opencode')?.available).toBe(false);
    expect(byId.get('copilot')?.available).toBe(false);
    // Every registered agent is represented in the result.
    expect(agents).toHaveLength(registry.size);
  });

  it('reports live vs fallback model sources', async () => {
    const registry = createRegistry();
    const agents = await detectAgents(registry, detectOpts());
    const byId = new Map(agents.map((a) => [a.id, a]));

    // Claude has no list/fetch models → fallback hints.
    expect(byId.get('claude')?.modelsSource).toBe('fallback');
    // Codex parses `debug models` JSON → live.
    const codex = byId.get('codex');
    expect(codex?.modelsSource).toBe('live');
    expect(codex?.models.map((m) => m.id)).toEqual(['default', 'gpt-5', 'o3']);
    // Pi parses its stderr provider table → live.
    const pi = byId.get('pi');
    expect(pi?.modelsSource).toBe('live');
    expect(pi?.models.map((m) => m.id)).toContain('anthropic/claude-sonnet-4-5');
  });

  it('detects capabilities from --help and feeds them into buildArgs', async () => {
    const claude = await detectAgent(claudeAgentDef, detectOpts());
    expect(claude.capabilities).toMatchObject({
      addDir: true,
      partialMessages: true,
    });
    const args = claudeAgentDef.buildArgs('hi', [], ['/tmp/skills'], {}, {
      capabilities: claude.capabilities,
    });
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--add-dir');
  });

  it('infers auth status from env vars and home files', async () => {
    const missing = await detectAgent(claudeAgentDef, detectOpts());
    expect(missing.authStatus).toBe('missing');
    expect(missing.authMessage).toContain('ANTHROPIC_API_KEY');

    const ok = await detectAgent(
      claudeAgentDef,
      detectOpts({ env: { PATH: binDir, ANTHROPIC_API_KEY: 'sk-test' } }),
    );
    expect(ok.authStatus).toBe('ok');
  });

  it('treats a 127 exit from the version probe as not invocable', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (path.basename(ctrl.request.command) === 'claude') {
        ctrl.exit(127);
      } else {
        ctrl.exit(0);
      }
    });
    const claude = await detectAgent(
      claudeAgentDef,
      detectOpts({ transport }),
    );
    expect(claude.available).toBe(false);
  });

  it('treats an ENOENT carried in detail.errno as not invocable', async () => {
    // The version probe fails with our AgentSpawnError (code "spawn_failed"),
    // but the real OS errno lives in detail.errno. extractErrno must consult
    // detail/cause first — not the "spawn_failed" discriminant — so the agent
    // is reported unavailable rather than a ghost-available binary.
    const transport = createFakeTransport((ctrl) => {
      if (path.basename(ctrl.request.command) === 'claude') {
        ctrl.failSpawn(
          new AgentSpawnError('spawn claude ENOENT', { detail: { errno: 'ENOENT' } }),
        );
      } else {
        ctrl.exit(0);
      }
    });
    const claude = await detectAgent(claudeAgentDef, detectOpts({ transport }));
    expect(claude.available).toBe(false);
  });

  it('treats an EACCES carried in the error cause as not invocable', async () => {
    const transport = createFakeTransport((ctrl) => {
      if (path.basename(ctrl.request.command) === 'claude') {
        ctrl.failSpawn(
          new AgentSpawnError('spawn failed', { cause: { code: 'EACCES' } }),
        );
      } else {
        ctrl.exit(0);
      }
    });
    const claude = await detectAgent(claudeAgentDef, detectOpts({ transport }));
    expect(claude.available).toBe(false);
  });

  it('isolates a faulty definition without collapsing the result set', async () => {
    const registry = createRegistry();
    // A def that throws while its executable is being resolved.
    const evil = { ...claudeAgentDef, id: 'evil-agent', name: 'Evil', binEnvVar: undefined };
    Object.defineProperty(evil, 'fallbackBins', {
      get() {
        throw new Error('boom while resolving');
      },
    });
    registry.register(evil as RuntimeAgentDef);

    const agents = await detectAgents(registry, detectOpts());
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect(byId.get('evil-agent')?.available).toBe(false);
    // The healthy agents are still detected.
    expect(byId.get('claude')?.available).toBe(true);
    expect(agents).toHaveLength(registry.size);
  });
});

describe('RuntimeRegistry', () => {
  it('registers, overrides, and unregisters defs', () => {
    const registry = new RuntimeRegistry();
    const def = { ...claudeAgentDef, id: 'custom' } as RuntimeAgentDef;
    registry.register(def);
    expect(registry.has('custom')).toBe(true);
    expect(() => registry.register(def)).toThrow(/Duplicate/);
    registry.register({ ...def, name: 'Custom v2' }, { override: true });
    expect(registry.get('custom')?.name).toBe('Custom v2');
    expect(registry.unregister('custom')).toBe(true);
    expect(registry.has('custom')).toBe(false);
  });

  it('createRegistry can exclude builtins', () => {
    expect(createRegistry().size).toBeGreaterThanOrEqual(8);
    expect(createRegistry([], { includeBuiltins: false }).size).toBe(0);
  });

  it('records every spawn through the transport for assertions', async () => {
    const transport = probeTransport() as ReturnType<typeof createFakeTransport>;
    await detectAgent(claudeAgentDef, detectOpts({ transport }));
    const commands = transport.calls.map((c: SpawnRequest) => c.args.join(' '));
    expect(commands).toContain('--version');
  });
});
