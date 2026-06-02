/**
 * The runtime adapter contract.
 *
 * A {@link RuntimeAgentDef} is a declarative description of how to detect and
 * drive one agent CLI. The registry holds a set of these; detection turns each
 * into a {@link DetectedAgent}; the execution layer reads `buildArgs`,
 * `streamFormat`, and `promptViaStdin` to actually run it. Downstream projects
 * register their own defs to teach Omakase about a new agent without forking.
 *
 * See `docs/runtime-contract.md` for the full field-by-field reference.
 */

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export type RuntimeReasoningOption = RuntimeModelOption;

export type RuntimeModelSource = 'live' | 'fallback';

export interface RuntimeBuildOptions {
  model?: string | null;
  reasoning?: string | null;
}

export interface RuntimeContext {
  cwd?: string;
  /** True when this is not the first turn of the conversation. */
  hasPriorAssistantTurn?: boolean;
  /**
   * Capabilities discovered during detection (e.g. which optional `--help`
   * flags the installed CLI advertises). `buildArgs` reads this to gate flags
   * that older builds reject, without any global mutable state.
   */
  capabilities?: RuntimeCapabilityMap;
}

export type RuntimeCapabilityMap = Record<string, boolean>;

/**
 * How an adapter's stdout is parsed into {@link AgentEvent}s. The execution
 * layer ships parsers for the built-in formats; a custom def may name its own
 * format and register a matching parser.
 */
export type StreamFormat =
  | 'pi-rpc'
  | 'claude-stream-json'
  | 'codex-json'
  | 'plain-text'
  | (string & {});

export interface RuntimeListModels {
  args: string[];
  timeoutMs?: number;
  /** Parse `<bin> <args>` stdout into model options, or null if unusable. */
  parse(stdout: string): RuntimeModelOption[] | null;
}

/** Declarative auth heuristic: presence of any signal implies configured auth. */
export interface RuntimeAuthHints {
  /** Env vars whose presence implies the agent can authenticate. */
  envVars?: string[];
  /** Paths relative to the home directory that, if present, imply auth. */
  homeFiles?: string[];
}

export interface RuntimeAgentDef {
  id: string;
  name: string;
  /** Primary executable name searched on PATH. */
  bin: string;
  /** Alternate binary names tried in order if `bin` is not found. */
  fallbackBins?: string[];
  /** Env var that, when set to an absolute path, overrides discovery. */
  binEnvVar?: string;
  versionArgs: string[];
  versionProbeTimeoutMs?: number;
  /** `--help`-style args probed once to detect optional flag support. */
  helpArgs?: string[];
  /** Map of "flag string present in --help" -> capability key. */
  capabilityFlags?: Record<string, string>;
  /** Static capability hints merged under probed capabilities. */
  capabilities?: RuntimeCapabilityMap;
  fallbackModels: RuntimeModelOption[];
  listModels?: RuntimeListModels;
  fetchModels?(
    resolvedBin: string,
    env: NodeJS.ProcessEnv,
    run: ModelProbeRunner,
  ): Promise<RuntimeModelOption[] | null>;
  reasoningOptions?: RuntimeReasoningOption[];
  /**
   * Build the argv (excluding the binary) for a single run. The user prompt is
   * delivered separately via stdin when `promptViaStdin` is set, so most
   * adapters ignore `prompt` here.
   */
  buildArgs(
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    context?: RuntimeContext,
  ): string[];
  streamFormat: StreamFormat;
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  /** Extra env applied to both probes and runs. */
  env?: Record<string, string>;
  supportsImagePaths?: boolean;
  maxPromptArgBytes?: number;
  externalMcpInjection?: 'claude-mcp-json' | 'acp-merge' | 'opencode-env-content';
  supportsCustomModel?: boolean;
  auth?: RuntimeAuthHints;
  installUrl?: string;
  docsUrl?: string;
}

/**
 * A runner handed to `fetchModels` so model discovery goes through the same
 * (real or fake) transport as everything else.
 */
export type ModelProbeRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export type AuthStatus = 'ok' | 'missing' | 'unknown';

export interface DetectedAgent {
  id: string;
  name: string;
  bin: string;
  streamFormat: StreamFormat;
  promptViaStdin: boolean;
  supportsImagePaths: boolean;
  supportsCustomModel: boolean;
  reasoningOptions: RuntimeReasoningOption[];
  externalMcpInjection: RuntimeAgentDef['externalMcpInjection'];
  installUrl: string | undefined;
  docsUrl: string | undefined;
  // Detection outcome ↓
  available: boolean;
  path: string | undefined;
  version: string | null;
  models: RuntimeModelOption[];
  modelsSource: RuntimeModelSource;
  capabilities: RuntimeCapabilityMap;
  authStatus: AuthStatus;
  authMessage: string | undefined;
}
