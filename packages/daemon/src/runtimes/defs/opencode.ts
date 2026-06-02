import { DEFAULT_MODEL_OPTION, parseLineSeparatedModels } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const opencodeAgentDef: RuntimeAgentDef = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  fallbackBins: ['opencode-cli'],
  binEnvVar: 'OPENCODE_BIN',
  versionArgs: ['--version'],
  listModels: { args: ['models'], parse: parseLineSeparatedModels, timeoutMs: 8000 },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs(prompt, _imagePaths, _extraAllowedDirs = [], options = {}) {
    const args = ['run', '--print-logs'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    args.push(prompt);
    return args;
  },
  // OpenCode takes the message as a positional arg to `run`.
  promptViaStdin: false,
  streamFormat: 'plain-text',
  externalMcpInjection: 'opencode-env-content',
  auth: {
    envVars: ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    homeFiles: ['.local/share/opencode/auth.json', '.config/opencode'],
  },
  installUrl: 'https://github.com/sst/opencode',
};
