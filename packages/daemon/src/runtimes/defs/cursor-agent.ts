import { DEFAULT_MODEL_OPTION, parseLineSeparatedModels } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const cursorAgentDef: RuntimeAgentDef = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  binEnvVar: 'CURSOR_AGENT_BIN',
  versionArgs: ['--version'],
  listModels: { args: ['models'], parse: parseLineSeparatedModels, timeoutMs: 8000 },
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs(_prompt, _imagePaths, _extraAllowedDirs = [], options = {}) {
    const args = ['--print', '--output-format', 'text'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'plain-text',
  auth: {
    envVars: ['CURSOR_API_KEY'],
    homeFiles: ['.cursor/cli-config.json'],
  },
  installUrl: 'https://docs.cursor.com/en/cli/overview',
};
