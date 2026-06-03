import { DEFAULT_MODEL_OPTION } from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  // Drop-in forks that ship an argv-compatible CLI are tried after `claude`.
  fallbackBins: ['openclaude'],
  binEnvVar: 'CLAUDE_BIN',
  versionArgs: ['--version'],
  helpArgs: ['-p', '--help'],
  capabilityFlags: {
    '--include-partial-messages': 'partialMessages',
    '--add-dir': 'addDir',
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'sonnet', label: 'Sonnet (alias)' },
    { id: 'opus', label: 'Opus (alias)' },
    { id: 'haiku', label: 'Haiku (alias)' },
  ],
  buildArgs(_prompt, _imagePaths, extraAllowedDirs = [], options = {}, context = {}) {
    const caps = context.capabilities ?? {};
    // Prompt is delivered on stdin (stream-json) to dodge argv length caps and
    // to allow injecting tool_result blocks mid-run.
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
  auth: {
    envVars: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    // Only the credential store proves authentication. ~/.claude.json is a
    // general config file written even for unauthenticated installs, so keying
    // auth on it produced false 'ok'. The OAuth login writes .credentials.json.
    homeFiles: ['.claude/.credentials.json'],
  },
  installUrl: 'https://docs.claude.com/en/docs/claude-code',
  docsUrl: 'https://docs.claude.com/en/docs/claude-code',
};
