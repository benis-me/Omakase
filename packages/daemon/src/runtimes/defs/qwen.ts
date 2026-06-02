import { DEFAULT_MODEL_OPTION } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const qwenAgentDef: RuntimeAgentDef = {
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  binEnvVar: 'QWEN_BIN',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'qwen3-coder-plus', label: 'qwen3-coder-plus' },
    { id: 'qwen3-coder-flash', label: 'qwen3-coder-flash' },
  ],
  buildArgs(_prompt, _imagePaths, _extraAllowedDirs = [], options = {}) {
    const args = ['--yolo'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  // Qwen Code is a Gemini-CLI fork: prompt via stdin, plain-text stream.
  promptViaStdin: true,
  streamFormat: 'plain-text',
  auth: {
    envVars: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY'],
    homeFiles: ['.qwen/oauth_creds.json'],
  },
  installUrl: 'https://github.com/QwenLM/qwen-code',
};
