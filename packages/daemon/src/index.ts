// @omakase/daemon — public entrypoint.
//
// The daemon is the dependency-free base layer for any Omakase agent: it
// detects local agent CLIs, runs them through a single streaming protocol,
// and loads skills. Downstream packages (@omakase/core, your own runtime)
// import from here.

export const DAEMON_VERSION = '0.1.0';

// ── Unified event protocol ────────────────────────────────────────────────
export type {
  AgentEvent,
  AgentEventType,
  AgentStatusLabel,
  AgentEndReason,
  AgentToolCall,
  AgentRunResult,
  ResultAccumulator,
  TokenUsage,
} from './protocol/events.js';
export {
  isAgentEvent,
  createResultAccumulator,
  collectAgentResult,
} from './protocol/events.js';

export type { JsonLineStream, JsonCandidateState } from './protocol/json-lines.js';
export { createJsonLineStream, classifyJsonCandidate } from './protocol/json-lines.js';

// ── Errors ─────────────────────────────────────────────────────────────────
export type { AgentErrorCode, AgentRuntimeErrorOptions } from './runtime/errors.js';
export {
  AgentRuntimeError,
  AgentNotInstalledError,
  AgentAuthMissingError,
  AgentSpawnError,
  AgentProtocolError,
  AgentTimeoutError,
  AgentCancelledError,
  PromptTooLargeError,
  isAgentRuntimeError,
  errnoCode,
  errorMessage,
} from './runtime/errors.js';

// ── Transport ────────────────────────────────────────────────────────────
export type {
  Transport,
  TransportProcess,
  SpawnRequest,
  ProcessExit,
} from './runtime/transport.js';
export { createNodeTransport } from './runtime/transport.js';
export type { PushStream } from './runtime/push-stream.js';
export { createPushStream } from './runtime/push-stream.js';
export type { ExecResult, ExecOptions } from './runtime/exec.js';
export { execCollect } from './runtime/exec.js';

// ── Runtime definitions, registry & detection ───────────────────────────────
export type {
  RuntimeAgentDef,
  RuntimeModelOption,
  RuntimeReasoningOption,
  RuntimeModelSource,
  RuntimeBuildOptions,
  RuntimeContext,
  RuntimeCapabilityMap,
  RuntimeListModels,
  RuntimeAuthHints,
  ModelProbeRunner,
  StreamFormat,
  AuthStatus,
  DetectedAgent,
} from './runtimes/types.js';
export {
  DEFAULT_MODEL_OPTION,
  STANDARD_REASONING_OPTIONS,
  parseProviderTableModels,
  parseLineSeparatedModels,
  parseCodexDebugModels,
  clampCodexReasoning,
} from './runtimes/shared.js';
export {
  resolveExecutable,
  resolveOnPath,
  isExecutableFile,
  computePathDirs,
  wellKnownToolchainDirs,
} from './runtimes/executables.js';
export type {
  ExecutableResolution,
  ExecutableResolveContext,
} from './runtimes/executables.js';
export { RuntimeRegistry, createRegistry } from './runtimes/registry.js';
export type { RegisterOptions, CreateRegistryOptions } from './runtimes/registry.js';
export { BUILTIN_AGENT_DEFS } from './runtimes/defs/index.js';
export {
  claudeAgentDef,
  codexAgentDef,
  piAgentDef,
  geminiAgentDef,
  opencodeAgentDef,
  cursorAgentDef,
  qwenAgentDef,
  copilotAgentDef,
} from './runtimes/defs/index.js';
export { detectAgent, detectAgents, resolveRuntime } from './runtimes/detection.js';
export type { DetectionOptions, ResolvedRuntime } from './runtimes/detection.js';

// ── Stream parsers (per format) ──────────────────────────────────────────────
export type { JsonEventMapper, JsonMapperState } from './runtime/parsers.js';
export {
  getJsonMapper,
  claudeStreamJsonMapper,
  codexJsonMapper,
} from './runtime/parsers.js';
export type { PiMapperState, PiMapResult } from './protocol/pi-rpc.js';
export {
  mapPiRpcEvent,
  isExtensionUiRequest,
  buildExtensionUiResponse,
  buildPiPromptCommand,
  buildPiAbortCommand,
} from './protocol/pi-rpc.js';

// ── Execution API ────────────────────────────────────────────────────────────
export type { AgentRunInput, AgentExecutor, ExecutorContext } from './runtime/executor.js';
export type { StreamDriver } from './runtime/stream.js';
export { streamFromDriver, errorStream, deferStream } from './runtime/stream.js';
export {
  applyMcpInjection,
  buildClaudeMcpJson,
  buildOpenCodeConfigContent,
  mergeAcpMcpServers,
} from './runtime/mcp.js';
export type {
  McpServerConfig,
  McpInjectionStrategy,
  AcpMcpServer,
  ApplyMcpInjectionContext,
  ApplyMcpInjectionResult,
} from './runtime/mcp.js';
export { spawnExecutor } from './runtime/executors/spawn.js';
export { piRpcExecutor } from './runtime/executors/pi-rpc.js';
export {
  createScriptedAgent,
  echoAgent,
  localResponderAgent,
  summarizeProject,
} from './runtime/executors/builtin.js';
export type { ScriptedHandler } from './runtime/executors/builtin.js';
export {
  createAgentRuntime,
  BUILTIN_AGENT_ID,
} from './runtime/runtime.js';
export type { AgentRuntime, AgentRuntimeOptions } from './runtime/runtime.js';

// ── Skills ───────────────────────────────────────────────────────────────────
export {
  parseFrontmatter,
} from './skills/frontmatter.js';
export type {
  FrontmatterData,
  FrontmatterValue,
  FrontmatterScalar,
  ParsedFrontmatter,
} from './skills/frontmatter.js';
export {
  listSkills,
  findSkillById,
  selectSkillsForPrompt,
  renderSkillContext,
} from './skills/skills.js';
export type {
  SkillInfo,
  SkillRoot,
  SkillSource,
  SkillSelectionOptions,
} from './skills/skills.js';
