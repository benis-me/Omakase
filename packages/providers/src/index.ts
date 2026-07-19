// @omakase/providers — detect & drive installed AI agent CLIs.

export type {
  AgentProvider,
  TurnContext,
  SpawnPlan,
  OutputFormat,
  AgentTurnResult,
  StreamParser,
  ProviderInfo,
} from './types.ts';

export {
  AGENT_PROVIDERS,
  getProvider,
  commandBase,
} from './registry.ts';

export {
  supportsPermission,
  claudeProvider,
  codexProvider,
  geminiProvider,
  cursorProvider,
} from './providers.ts';

export {
  detectProviders,
  detectAvailable,
  detectCached,
  probeVersion,
  resolveBin,
  loadAgentsCache,
  saveAgentsCache,
  type DetectOptions,
} from './detect.ts';

export { runTurn, type RunTurnOptions } from './runner.ts';
export { BunSpawner, type ProcessSpawner, type SpawnRequest, type SpawnResult } from './spawn.ts';
export { agentSpawnEnv, augmentedPath } from './env.ts';
export { ClaudeStreamParser, GenericJsonParser, CodexJsonParser, CursorStreamParser, TextTailParser, toolSummary, isRateLimit, isNoise } from './parsers.ts';
