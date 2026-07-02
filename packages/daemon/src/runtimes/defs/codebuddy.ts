import { DEFAULT_MODEL_OPTION } from '../shared.js';
import type { RuntimeAgentDef, RuntimeModelOption } from '../types.js';

function parseCodeBuddyHelpModels(text: string): RuntimeModelOption[] | null {
  const match = /Currently supported:\s*\(([^)]+)\)/i.exec(text);
  if (!match?.[1]) return null;

  const models: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  const seen = new Set<string>([DEFAULT_MODEL_OPTION.id]);
  for (const raw of match[1].split(',')) {
    const id = raw.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models.length > 1 ? models : null;
}

export const codebuddyAgentDef: RuntimeAgentDef = {
  id: 'codebuddy',
  name: 'CodeBuddy',
  bin: 'codebuddy',
  binEnvVar: 'CODEBUDDY_BIN',
  versionArgs: ['--version'],
  helpArgs: ['-p', '--help'],
  capabilityFlags: {
    '--include-partial-messages': 'partialMessages',
    '--add-dir': 'addDir',
  },
  async fetchModels(_bin, _env, run) {
    for (const args of [['--help'], ['-p', '--help']]) {
      const result = await run(args, { timeoutMs: 4000 });
      const parsed = parseCodeBuddyHelpModels(`${result.stdout}\n${result.stderr}`);
      if (parsed) return parsed;
    }
    return null;
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  ],
  buildArgs(_prompt, _imagePaths, extraAllowedDirs = [], options = {}, context = {}) {
    const caps = context.capabilities ?? {};
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (caps.partialMessages) args.push('--include-partial-messages');
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    const dirs = (extraAllowedDirs ?? []).filter(
      (dir) => typeof dir === 'string' && dir.length > 0,
    );
    if (dirs.length > 0 && caps.addDir !== false) {
      args.push('--add-dir', ...dirs);
    }
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  },
  promptViaStdin: true,
  promptInputFormat: 'stream-json',
  streamFormat: 'claude-stream-json',
  supportsImagePaths: true,
  externalMcpInjection: 'claude-mcp-json',
};
