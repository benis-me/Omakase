/**
 * The unified Omakase agent event model.
 *
 * Every runtime adapter — whether it drives Claude Code's stream-json, Codex's
 * JSON event stream, pi's RPC protocol, or an in-process scripted agent — maps
 * its native output into this single discriminated union. Downstream consumers
 * (the orchestrator, the CLI/TUI, tests) only ever see {@link AgentEvent}, so
 * adding a new agent never changes a consumer.
 */

export type AgentStatusLabel =
  | 'initializing'
  | 'thinking'
  | 'working'
  | 'streaming'
  | 'compacting'
  | 'retrying'
  | 'done';

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
}

/** Why an agent run finished. */
export type AgentEndReason = 'completed' | 'cancelled' | 'error';

export type AgentEvent =
  | {
      type: 'status';
      label: AgentStatusLabel;
      /** Resolved model id, surfaced on the first status event when known. */
      model?: string | null;
      /** Time-to-first-token in ms, attached to the first `streaming` status. */
      ttftMs?: number;
    }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'tool_use'; id: string | null; name: string | null; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string | null;
      content: string;
      isError: boolean;
    }
  | {
      type: 'usage';
      usage: TokenUsage;
      costUsd?: number | null;
      durationMs?: number;
    }
  | { type: 'error'; message: string; raw?: unknown }
  | { type: 'done'; reason: AgentEndReason };

export type AgentEventType = AgentEvent['type'];

/** Narrow an event to a specific variant. */
export function isAgentEvent<T extends AgentEventType>(
  event: AgentEvent,
  type: T,
): event is Extract<AgentEvent, { type: T }> {
  return event.type === type;
}

export interface AgentToolCall {
  id: string | null;
  name: string | null;
  input: unknown;
  /** Populated when a matching `tool_result` is later observed. */
  result?: { content: string; isError: boolean };
}

/**
 * The folded outcome of an agent run. Built by replaying events through
 * {@link createResultAccumulator}; this is what `runAgent` returns and what
 * the orchestrator stores against a task.
 */
export interface AgentRunResult {
  /** Concatenated assistant text deltas. */
  text: string;
  /** Concatenated thinking/reasoning deltas. */
  thinking: string;
  toolCalls: AgentToolCall[];
  usage: TokenUsage | null;
  costUsd: number | null;
  status: AgentEndReason;
  /** First error message observed, if any. */
  error: string | null;
  model: string | null;
}

export interface ResultAccumulator {
  push(event: AgentEvent): void;
  /** Snapshot the accumulated result so far. */
  result(): AgentRunResult;
}

/**
 * Fold a stream of {@link AgentEvent}s into an {@link AgentRunResult}.
 *
 * The accumulator is intentionally tolerant: a stream that ends without a
 * `done` event is reported as `completed` unless an `error` event was seen,
 * matching how a clean process exit is treated by the execution layer.
 */
export function createResultAccumulator(): ResultAccumulator {
  let text = '';
  let thinking = '';
  const toolCalls: AgentToolCall[] = [];
  const toolCallsById = new Map<string, AgentToolCall>();
  let usage: TokenUsage | null = null;
  let costUsd: number | null = null;
  let status: AgentEndReason | null = null;
  let error: string | null = null;
  let model: string | null = null;

  return {
    push(event: AgentEvent): void {
      switch (event.type) {
        case 'status':
          if (event.model != null && model == null) model = event.model;
          break;
        case 'text_delta':
          text += event.delta;
          break;
        case 'thinking_delta':
          thinking += event.delta;
          break;
        case 'tool_use': {
          const call: AgentToolCall = {
            id: event.id,
            name: event.name,
            input: event.input,
          };
          toolCalls.push(call);
          if (event.id) toolCallsById.set(event.id, call);
          break;
        }
        case 'tool_result': {
          const call =
            event.toolUseId != null
              ? toolCallsById.get(event.toolUseId)
              : undefined;
          if (call) {
            call.result = { content: event.content, isError: event.isError };
          }
          break;
        }
        case 'usage':
          usage = event.usage;
          if (event.costUsd != null) costUsd = event.costUsd;
          break;
        case 'error':
          if (error == null) error = event.message;
          if (status == null) status = 'error';
          break;
        case 'done':
          status = event.reason;
          break;
        case 'thinking_start':
        case 'thinking_end':
          break;
      }
    },
    result(): AgentRunResult {
      return {
        text,
        thinking,
        toolCalls: toolCalls.map((c) => ({ ...c })),
        usage,
        costUsd,
        status: status ?? (error ? 'error' : 'completed'),
        error,
        model,
      };
    },
  };
}

/** Drain an async stream of events into a single result. */
export async function collectAgentResult(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentRunResult> {
  const acc = createResultAccumulator();
  for await (const event of events) acc.push(event);
  return acc.result();
}
