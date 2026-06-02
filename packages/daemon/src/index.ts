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
