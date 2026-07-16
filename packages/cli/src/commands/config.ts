import { parseArgs } from '../args.ts';
import { openContext } from '../context.ts';
import { print, printErr, c } from '../ui.ts';

const KEYS = ['defaultProvider', 'defaultModel', 'maxAgentsPerRun', 'autoApprove', 'providerPreference'] as const;

export async function cmdConfig(rawArgs: string[]): Promise<number> {
  const sub = rawArgs[0] ?? 'list';
  const args = parseArgs(rawArgs.slice(1), {});
  const { workspace } = openContext();

  if (sub === 'list' || sub === 'get') {
    const key = args.positionals[0];
    const settings = workspace.settings as Record<string, unknown>;
    if (key) {
      print(`${key} = ${format(settings[key])}`);
      return 0;
    }
    print(c.bold('\nWorkspace settings') + c.dim(`  (${workspace.paths.configFile})`));
    for (const k of KEYS) print(`  ${c.cyan(k.padEnd(20))} ${format(settings[k])}`);
    return 0;
  }

  if (sub === 'set') {
    const key = args.positionals[0];
    const value = args.positionals.slice(1).join(' ');
    if (!key || value === '') {
      printErr('Usage: omks config set <key> <value>');
      return 1;
    }
    if (!KEYS.includes(key as never)) {
      printErr(c.yellow(`Unknown key "${key}". Known: ${KEYS.join(', ')}`));
      return 1;
    }
    workspace.updateSettings({ [key]: coerce(key, value) });
    print(`${c.green('✓')} ${key} = ${format(coerce(key, value))}`);
    return 0;
  }

  printErr('Usage: omks config [list|get <key>|set <key> <value>]');
  return 1;
}

function coerce(key: string, value: string): unknown {
  if (key === 'maxAgentsPerRun') return Number(value);
  if (key === 'autoApprove') return value === 'true' || value === '1';
  if (key === 'providerPreference') return value.split(',').map((s) => s.trim());
  return value;
}

function format(v: unknown): string {
  if (v === undefined) return c.dim('(unset)');
  return Array.isArray(v) ? v.join(', ') : String(v);
}
