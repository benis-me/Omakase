import { print, c, banner } from '../ui.ts';

export const VERSION = '0.1.0';

export function cmdHelp(): number {
  const h = (s: string) => c.bold(s);
  const cmd = (name: string, desc: string) => `  ${c.cyan(name.padEnd(26))} ${c.dim(desc)}`;
  print(`${banner()}  ${c.dim('v' + VERSION)}

${h('USAGE')}
  ${c.cyan('omks')} ${c.dim('[command] [options]')}
  ${c.cyan('omks')} ${c.dim('"<goal>"')}            run a goal with the default workflow
  ${c.cyan('omks')}                     launch the interactive TUI

${h('CORE')}
${cmd('init [name]', 'create an .omks workspace here')}
${cmd('run "<goal>"', 'drive a goal to completion (headless)')}
${cmd('resume <runId>', 'resume an interrupted run')}
${cmd('runs [show <id>]', 'list / inspect past runs')}
${cmd('logs <runId> [-f]', 'print / follow a run’s event stream')}

${h('WORKFLOWS')}   ${c.dim('reusable, versioned, skills-like')}
${cmd('workflow list', 'list available workflows')}
${cmd('workflow show <name>', 'show a workflow’s docs')}
${cmd('workflow new <name>', 'scaffold a new workflow (--flat for a single file)')}
${cmd('workflow run <name> "<goal>"', 'run a specific workflow')}
${cmd('workflow test <name>', 'dry-run a workflow with a mock harness (no cost)')}
  ${cmd('workflow lint [name]', 'check workflows for things that break resume')}
${cmd('workflow version <name>', 'show / --bump patch|minor|major')}

${h('AGENTS & CONFIG')}
${cmd('agent list', 'show installed agent CLIs')}
${cmd('agent scan', 're-detect providers + models')}
${cmd('agent check', 'verify each provider is authenticated (tiny real call)')}
${cmd('config [get|set|list]', 'workspace settings')}
${cmd('session [list|show]', 'grouped runs')}
${cmd('doctor', 'environment diagnostics')}
${cmd('web [--port n] [--open]', 'launch the browser dashboard (Vite + React)')}
${cmd('mcp', 'run as an MCP server (stdio) for other agents')}

${h('RUN OPTIONS')}
  ${c.dim('--workflow, -w <name>    pick a workflow (default: goal)')}
  ${c.dim('--provider, -p <id>      pin a provider (claude|codex|gemini|cursor-agent)')}
  ${c.dim('--model, -m <model>      pin a model')}
  ${c.dim('--check "<cmd>"          success check: passes when the command exits 0 (repeatable)')}
  ${c.dim('--criteria "<text>"      natural-language success criterion, judged (repeatable)')}
  ${c.dim('--max-agents <n>         cap agent calls   --concurrency <n>  parallelism')}
  ${c.dim('--max-usd <n>            cap total spend   --max-time <sec>   wall-clock budget')}
  ${c.dim('--param k=v              workflow parameter (repeatable)   --session <id>  continue')}
  ${c.dim('--cwd <dir>              working directory   --json  emit JSONL events')}

${c.dim('Docs: https://github.com/benis-me/Omakase')}`);
  return 0;
}
