import {
  DEFAULT_MODEL_OPTION,
  clampCodexReasoning,
  parseCodexDebugModels,
} from '../shared.js';
import type { RuntimeAgentDef, RuntimeReasoningOption } from '../types.js';

const CODEX_REASONING: RuntimeReasoningOption[] = [
  { id: 'default', label: 'Default' },
  { id: 'none', label: 'None' },
  { id: 'minimal', label: 'Minimal' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'XHigh' },
];

export const codexAgentDef: RuntimeAgentDef = {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  binEnvVar: 'CODEX_BIN',
  versionArgs: ['--version'],
  listModels: {
    args: ['debug', 'models'],
    parse: parseCodexDebugModels,
    timeoutMs: 5000,
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'gpt-5.1', label: 'gpt-5.1' },
    { id: 'gpt-5-codex', label: 'gpt-5-codex' },
    { id: 'gpt-5', label: 'gpt-5' },
    { id: 'o4-mini', label: 'o4-mini' },
    { id: 'o3', label: 'o3' },
  ],
  reasoningOptions: CODEX_REASONING,
  buildArgs(_prompt, _imagePaths, extraAllowedDirs = [], options = {}, context = {}) {
    const dangerFullAccess = process.platform === 'win32';
    const args = dangerFullAccess
      ? ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access']
      : [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '-c',
          'sandbox_workspace_write.network_access=true',
        ];
    if (context.cwd) args.push('-C', context.cwd);
    for (const dir of (extraAllowedDirs ?? []).filter(Boolean)) {
      args.push('--add-dir', dir);
    }
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    if (options.reasoning && options.reasoning !== 'default') {
      const effort = clampCodexReasoning(options.model, options.reasoning);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'codex-json',
  auth: {
    envVars: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    homeFiles: ['.codex/auth.json'],
  },
  installUrl: 'https://github.com/openai/codex',
  docsUrl: 'https://github.com/openai/codex',
};
