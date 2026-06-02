/**
 * `createAgentRuntime` is the daemon's top-level entrypoint. It owns a
 * registry and a transport, knows how to detect agents, and routes a run
 * request to the right executor:
 *   1. a custom in-process executor registered for the agent id,
 *   2. the built-in executor (agent id `builtin`, or any unresolved agent
 *      when `fallbackToBuiltin` is set),
 *   3. a registry def — spawned through the pi RPC or generic spawn executor.
 */
import type { AgentEvent, AgentRunResult } from '../protocol/events.js';
import { collectAgentResult } from '../protocol/events.js';
import {
  detectAgent,
  detectAgents,
  resolveRuntime,
  type DetectionOptions,
} from '../runtimes/detection.js';
import { createRegistry, RuntimeRegistry } from '../runtimes/registry.js';
import type { DetectedAgent } from '../runtimes/types.js';
import { AgentNotInstalledError } from './errors.js';
import { localResponderAgent } from './executors/builtin.js';
import { piRpcExecutor } from './executors/pi-rpc.js';
import { spawnExecutor } from './executors/spawn.js';
import type { AgentExecutor, AgentRunInput, ExecutorContext } from './executor.js';
import { deferStream, errorStream } from './stream.js';
import { createNodeTransport, type Transport } from './transport.js';

export const BUILTIN_AGENT_ID = 'builtin';

export interface AgentRuntimeOptions {
  registry?: RuntimeRegistry;
  transport?: Transport;
  /** Detection/resolution options (env, home, PATH dirs). */
  detection?: DetectionOptions;
  /** Custom in-process executors keyed by agent id. */
  executors?: Record<string, AgentExecutor>;
  /** Executor used for the `builtin` agent id (default: localResponderAgent). */
  builtinExecutor?: AgentExecutor;
  /** When true, an unresolved/unknown agent falls back to the builtin executor. */
  fallbackToBuiltin?: boolean;
  /** Injectable clock for deterministic timing in tests. */
  now?: () => number;
}

export interface AgentRuntime {
  readonly registry: RuntimeRegistry;
  readonly transport: Transport;
  /** Detect all registered agents. */
  detect(options?: DetectionOptions): Promise<DetectedAgent[]>;
  detectOne(id: string, options?: DetectionOptions): Promise<DetectedAgent | undefined>;
  /** Run an agent and stream events. */
  streamAgentEvents(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /** Run an agent and collect the folded result. */
  runAgent(input: AgentRunInput): Promise<AgentRunResult>;
  /** Register a custom in-process executor at runtime. */
  registerExecutor(id: string, executor: AgentExecutor): void;
}

export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  const registry = options.registry ?? createRegistry();
  const transport = options.transport ?? createNodeTransport();
  const detectionOptions = options.detection ?? {};
  const now = options.now ?? (() => Date.now());
  const executors = new Map<string, AgentExecutor>(
    Object.entries(options.executors ?? {}),
  );
  const builtinExecutor = options.builtinExecutor ?? localResponderAgent;

  const baseCtx = (input: AgentRunInput): ExecutorContext => ({
    input,
    transport,
    now,
  });

  const streamAgentEvents = (input: AgentRunInput): AsyncIterable<AgentEvent> => {
    // 1. Custom in-process executor.
    const custom = executors.get(input.agentId);
    if (custom) return custom(baseCtx(input));

    // 2. Built-in agent.
    if (input.agentId === BUILTIN_AGENT_ID) return builtinExecutor(baseCtx(input));

    // 3. Registry def.
    const def = registry.get(input.agentId);
    if (!def) {
      if (options.fallbackToBuiltin) return builtinExecutor(baseCtx(input));
      return errorStream(
        new AgentNotInstalledError(input.agentId, `Unknown agent "${input.agentId}"`),
      );
    }

    return deferStream(async () => {
      const resolved = await resolveRuntime(def, {
        ...detectionOptions,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.env ? { env: input.env } : {}),
      });
      if (!resolved) {
        if (options.fallbackToBuiltin) return builtinExecutor(baseCtx(input));
        throw new AgentNotInstalledError(input.agentId);
      }
      const ctx: ExecutorContext = {
        ...baseCtx(input),
        def,
        resolvedBin: resolved.bin,
        capabilities: resolved.capabilities,
      };
      const executor = def.streamFormat === 'pi-rpc' ? piRpcExecutor : spawnExecutor;
      return executor(ctx);
    });
  };

  return {
    registry,
    transport,
    detect: (opts) => detectAgents(registry, { ...detectionOptions, ...opts }),
    detectOne: async (id, opts) => {
      const def = registry.get(id);
      if (!def) return undefined;
      return detectAgent(def, { ...detectionOptions, ...opts });
    },
    streamAgentEvents,
    runAgent: (input) => collectAgentResult(streamAgentEvents(input)),
    registerExecutor: (id, executor) => {
      executors.set(id, executor);
    },
  };
}
