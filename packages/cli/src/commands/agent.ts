import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProviders, loadAgentsCache, saveAgentsCache } from '@omakase/providers';
import { SubprocessHarness } from '@omakase/engine';
import { parseArgs } from '../args.ts';
import { tryOpenContext } from '../context.ts';
import { print, c, sym, spinner } from '../ui.ts';

export async function cmdAgent(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] ?? 'list';
  const args = parseArgs(rawArgs.slice(1), {});
  const ctx = tryOpenContext();

  if (sub === 'check' || sub === 'verify') {
    return checkAuth(args.positionals[0]);
  }

  if (sub === 'scan' || sub === 'refresh' || sub === 'rescan') {
    const stop = spinner('Scanning for installed agent CLIs…');
    const providers = await detectProviders({ discoverModels: true });
    stop();
    if (ctx) saveAgentsCache(ctx.workspace.paths.agentsCache, providers);
    renderProviders(providers);
    return 0;
  }

  // list (cached-first)
  const cached = ctx ? loadAgentsCache(ctx.workspace.paths.agentsCache) : null;
  const providers = cached ?? (await detectProviders({ discoverModels: false }));
  renderProviders(providers);
  if (!cached) print(c.dim('\n(live scan — run `omks agent scan` to cache with model lists)'));
  return 0;
}

/** Probe each available provider with a trivial real call to confirm it's authed. */
async function checkAuth(only?: string): Promise<number> {
  const providers = await detectProviders({ discoverModels: false });
  const avail = providers.filter((p) => p.available && (!only || p.id === only));
  if (avail.length === 0) {
    print(c.yellow(only ? `Provider not installed: ${only}` : 'No providers installed.'));
    return 1;
  }
  print(c.bold('\nProvider auth check') + c.dim('  (one tiny real call each)'));
  const harness = new SubprocessHarness();
  const tmp = mkdtempSync(join(tmpdir(), 'omks-check-'));
  let ok = 0;
  try {
    for (const p of avail) {
      const stop = spinner(`checking ${p.label}…`);
      const res = await harness.runAgent({
        provider: p.id,
        role: 'validator',
        title: 'auth check',
        prompt: 'Reply with exactly: OK',
        cwd: tmp,
        autoApprove: true,
        timeoutMs: 120_000, // some CLIs (e.g. codex) are slow to cold-start
      });
      stop();
      const good = res.status === 'ok';
      if (good) ok++;
      const detail = good ? c.green('authenticated') : c.red(res.text.replace(/\s+/g, ' ').trim().slice(0, 70));
      print(`  ${good ? sym.ok : c.red('✗')} ${c.bold(p.label.padEnd(16))} ${detail}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  print(c.dim(`\n${ok}/${avail.length} authenticated`));
  return ok > 0 ? 0 : 1;
}

function renderProviders(providers: Awaited<ReturnType<typeof detectProviders>>): number {
  print(c.bold('\nAgent providers'));
  for (const p of providers) {
    const badge = p.available ? sym.ok : c.dim('·');
    const ver = p.version ? c.dim(p.version.slice(0, 24)) : '';
    const models = p.models.length ? c.dim(`  models: ${p.models.slice(0, 4).join(', ')}${p.models.length > 4 ? '…' : ''}`) : '';
    print(`  ${badge} ${c.bold(p.label.padEnd(18))} ${p.available ? c.green(p.command) : c.dim('not installed')} ${ver}${p.available ? models : ''}`);
  }
  const n = providers.filter((p) => p.available).length;
  print(c.dim(`\n${n} provider(s) available`));
  return 0;
}
