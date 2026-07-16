import { detectProviders } from '@omakase/providers';
import { discoverWorkflows } from '@omakase/engine';
import { Workspace } from '@omakase/core';
import { print, c, sym, banner, spinner } from '../ui.ts';

export async function cmdDoctor(): Promise<number> {
  print(banner() + '\n');
  const check = (ok: boolean, label: string, detail = '') =>
    print(`  ${ok ? sym.ok : c.red('✗')} ${label}${detail ? c.dim('  ' + detail) : ''}`);

  // Runtime
  check(true, 'Bun', Bun.version);
  check(Boolean(process.stdout.isTTY), 'Interactive TTY', process.stdout.isTTY ? 'yes' : 'no (TUI unavailable)');

  // Workspace
  const ws = Workspace.find();
  check(Boolean(ws), 'Workspace', ws ? ws.paths.dir : 'none (run `omks init`)');

  // Providers
  const stop = spinner('Probing agent providers…');
  const providers = await detectProviders({ discoverModels: false });
  stop();
  const available = providers.filter((p) => p.available);
  check(available.length > 0, `Agent providers (${available.length})`, available.map((p) => p.id).join(', ') || 'none installed');
  for (const p of providers.filter((x) => !x.available)) {
    print(c.dim(`      · ${p.label} not found (${p.command})`));
  }

  // Workflows
  const wf = discoverWorkflows(ws ? { workspace: ws.paths.workflows } : {});
  check(wf.length > 0, `Workflows (${wf.length})`, wf.map((m) => m.name).slice(0, 8).join(', '));

  const healthy = available.length > 0;
  print(
    healthy
      ? `\n${sym.ok} ${c.green('Ready.')} Try: ${c.cyan('omks run "your goal"')}`
      : `\n${c.yellow('!')} Install an agent CLI (claude, codex, gemini, cursor-agent) to get started.`,
  );
  return healthy ? 0 : 1;
}
