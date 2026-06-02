import { DEFAULT_MODEL_OPTION } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const copilotAgentDef: RuntimeAgentDef = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  bin: 'copilot',
  binEnvVar: 'COPILOT_BIN',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
    { id: 'gpt-5', label: 'GPT-5' },
  ],
  buildArgs(_prompt, _imagePaths, _extraAllowedDirs = [], options = {}) {
    const args = ['-p', '--allow-all-tools'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'plain-text',
  auth: {
    envVars: ['GITHUB_TOKEN', 'GH_TOKEN', 'COPILOT_API_KEY'],
    homeFiles: ['.config/github-copilot/hosts.json', '.copilot/config.json'],
  },
  installUrl: 'https://github.com/github/copilot-cli',
};
