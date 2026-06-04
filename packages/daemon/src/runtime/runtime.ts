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
  type ResolvedRuntime,
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
import { createTtlCache } from './ttl-cache.js';

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
  /**
   * Cache `resolveRuntime` results (bin path + capabilities) for this many ms
   * to avoid re-probing version/help on every run. 0 (default) disables the
   * cache so behaviour is deterministic; the CLI sets a few seconds.
   */
  detectionCacheTtlMs?: number;
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
  /** Clear any cached detection/resolution results. */
  refreshDetection(): void;
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
  const cacheTtl = options.detectionCacheTtlMs ?? 0;
  const resolveCache = createTtlCache<ResolvedRuntime>(cacheTtl, now);

  const baseCtx = (input: AgentRunInput): ExecutorContext => ({
    input,
    transport,
    now,
  });

  const resolveWithCache = async (
    def: NonNullable<ReturnType<typeof registry.get>>,
    input: AgentRunInput,
  ): Promise<ResolvedRuntime | null> => {
    // The key must include everything that changes resolution — cwd, the
    // binEnvVar override, and PATH — so a per-run env override can't be served a
    // binary/capabilities resolved under a different env.
    const env = input.env;
    const binOverride = def.binEnvVar ? env?.[def.binEnvVar] ?? '' : '';
    const path = env?.PATH ?? env?.Path ?? '';
    const key = JSON.stringify([input.agentId, input.cwd ?? '', binOverride, path]);
    const hit = resolveCache.get(key);
    if (hit) return hit;
    const resolved = await resolveRuntime(def, {
      ...detectionOptions,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.env ? { env: input.env } : {}),
    });
    // Only memoize successful resolutions: a missing binary must be re-probed
    // each run so installing it mid-TTL takes effect immediately. The cache
    // expires reads past the TTL and sweeps stale keys on write, so a long-lived
    // multi-cwd/env daemon stays bounded by currently-fresh tuples.
    if (resolved) resolveCache.set(key, resolved);
    return resolved;
  };

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
      const resolved = await resolveWithCache(def, input);
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
    refreshDetection: () => {
      resolveCache.clear();
    },
  };
}
