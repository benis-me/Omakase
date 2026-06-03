/**
 * Executor contracts. An {@link AgentExecutor} turns a run request into a
 * stream of {@link AgentEvent}s. The daemon ships three kinds:
 *   - spawn-based (external CLIs via the transport + a format parser),
 *   - pi RPC (the interactive built-in protocol),
 *   - in-process (deterministic agents that need no subprocess).
 * Downstream code can register its own executor for any agent id.
 */
import type { AgentEvent } from '../protocol/events.js';
import type { DetectedAgent, RuntimeAgentDef } from '../runtimes/types.js';
import type { McpServerConfig } from './mcp.js';
import type { Transport } from './transport.js';

export interface AgentRunInput {
  /** Which agent to run. Resolved against custom executors, then the builtin, then the registry. */
  agentId: string;
  prompt: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  model?: string | null;
  reasoning?: string | null;
  /** Extra directories the agent should be allowed to read outside cwd. */
  extraAllowedDirs?: string[];
  /** Absolute paths to images for multimodal input (adapters that support it). */
  imagePaths?: string[];
  /** External MCP servers to forward to the agent via its declared strategy. */
  mcpServers?: McpServerConfig[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** True when continuing an existing conversation rather than starting fresh. */
  hasPriorAssistantTurn?: boolean;
  /** Free-form metadata passed through to in-process executors (e.g. role). */
  metadata?: Record<string, unknown>;
}

export interface ExecutorContext {
  input: AgentRunInput;
  transport: Transport;
  def?: RuntimeAgentDef;
  detected?: DetectedAgent;
  /** Resolved absolute path to the agent binary (spawn-based executors). */
  resolvedBin?: string;
  /** Capabilities probed during resolution, fed to `buildArgs`. */
  capabilities?: Record<string, boolean>;
  now(): number;
}

export type AgentExecutor = (ctx: ExecutorContext) => AsyncIterable<AgentEvent>;
