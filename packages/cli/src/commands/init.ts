import { Workspace } from '@omakase/core';
import { detectAvailable, saveAgentsCache } from '@omakase/providers';
import type { ParsedArgs } from '../args.ts';
import { print, c, sym, banner, spinner } from '../ui.ts';

export async function cmdInit(args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  const cwd = process.cwd();
  const existing = Workspace.find(cwd);
  if (existing && existing.root === cwd) {
    print(`${sym.ok} Workspace already initialized at ${c.dim(existing.paths.dir)}`);
    return 0;
  }

  const ws = Workspace.init(cwd, name);
  print(banner());
  print(`${sym.ok} Initialized Omakase workspace ${c.bold(ws.getConfig().name)}`);
  print(`  ${c.dim(ws.paths.dir)}`);

  const stop = spinner('Detecting installed agent CLIs…');
  const providers = await detectAvailable({ discoverModels: false });
  stop();
  saveAgentsCache(ws.paths.agentsCache, await detectAvailable({ discoverModels: false }));

  if (providers.length) {
    print(`\n${sym.arrow} Providers found:`);
    for (const p of providers) {
      print(`  ${sym.ok} ${c.bold(p.label)} ${c.dim(p.version ?? '')}`);
    }
  } else {
    print(`\n${c.yellow('!')} No agent CLIs detected. Install one of: claude, codex, gemini, cursor-agent.`);
  }
  print(`\nNext: ${c.cyan('omks run "your goal here"')}  or just  ${c.cyan('omks')}  for the TUI.`);
  return 0;
}
