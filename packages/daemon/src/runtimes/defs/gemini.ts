import { DEFAULT_MODEL_OPTION } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const geminiAgentDef: RuntimeAgentDef = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  binEnvVar: 'GEMINI_BIN',
  versionArgs: ['--version'],
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  buildArgs(_prompt, _imagePaths, _extraAllowedDirs = [], options = {}) {
    const args = ['--yolo'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    return args;
  },
  // Gemini reads the prompt from stdin in non-interactive mode and streams
  // plain text to stdout.
  promptViaStdin: true,
  streamFormat: 'plain-text',
  supportsImagePaths: true,
  auth: {
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    homeFiles: ['.gemini/oauth_creds.json', '.config/gcloud'],
  },
  installUrl: 'https://github.com/google-gemini/gemini-cli',
};
