import path from 'node:path';
import {
  DEFAULT_MODEL_OPTION,
  STANDARD_REASONING_OPTIONS,
  parseProviderTableModels,
} from '../shared.js';
import type { RuntimeAgentDef } from '../types.js';

/**
 * Pi is the built-in agent base. It speaks `--mode rpc`: a JSON-RPC dialogue
 * over stdio where the daemon sends a `prompt` command and pi streams typed
 * events back. The {@link AgentEvent} mapping lives in `protocol/pi-rpc.ts`.
 */
export const piAgentDef: RuntimeAgentDef = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  binEnvVar: 'PI_BIN',
  versionArgs: ['--version'],
  // `pi --list-models` prints its TSV table to stderr.
  async fetchModels(_bin, _env, run) {
    const result = await run(['--list-models'], { timeoutMs: 20_000 });
    return parseProviderTableModels(result.stderr || result.stdout);
  },
  fallbackModels: [
    DEFAULT_MODEL_OPTION,
    { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (anthropic)' },
    { id: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5 (anthropic)' },
    { id: 'openai/gpt-5', label: 'GPT-5 (openai)' },
    { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (google)' },
  ],
  reasoningOptions: STANDARD_REASONING_OPTIONS,
  buildArgs(_prompt, _imagePaths, extraAllowedDirs = [], options = {}) {
    const args = ['--mode', 'rpc'];
    if (options.model && options.model !== 'default') {
      args.push('--model', options.model);
    }
    if (options.reasoning && options.reasoning !== 'default') {
      args.push('--thinking', options.reasoning);
    }
    for (const dir of (extraAllowedDirs ?? []).filter(
      (d) => typeof d === 'string' && path.isAbsolute(d),
    )) {
      args.push('--append-system-prompt', dir);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'pi-rpc',
  supportsImagePaths: true,
  auth: {
    envVars: ['PI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
    homeFiles: ['.pi/config.json', '.config/pi/config.json'],
  },
  installUrl: 'https://github.com/parallel-universe-pi/pi',
};
