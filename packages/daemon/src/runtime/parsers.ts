/**
 * Per-format stdout → {@link AgentEvent} mappers for the line-oriented JSON
 * stream formats. `plain-text` has no JSON mapper (the spawn executor emits a
 * `text_delta` per chunk); `pi-rpc` is handled by its dedicated session driver.
 *
 * Each mapper is pure given its `state` object, which it mutates to track
 * streaming bookkeeping (time-to-first-token, whether deltas have streamed so
 * a trailing full-message block should be suppressed).
 */
import type { AgentEvent, TokenUsage } from '../protocol/events.js';
import type { StreamFormat } from '../runtimes/types.js';

export interface JsonMapperState {
  startedAt: number;
  sentFirstToken: boolean;
  /** True once incremental text deltas have been emitted this run. */
  streamedText: boolean;
  /** Codex item ids already emitted, so item.started/completed of the same message dedup without dropping distinct messages. */
  emittedItemIds?: Set<string>;
  /** Last full agent-message text emitted (dedup fallback when an item has no id). */
  lastMessageText?: string;
  now(): number;
}

export type JsonEventMapper = (raw: unknown, state: JsonMapperState) => AgentEvent[];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function firstNum(obj: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = num(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function codexUsageFrom(info: JsonRecord): TokenUsage {
  const usage: TokenUsage = {};
  const input = firstNum(info, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  const output = firstNum(info, ['output_tokens', 'outputTokens', 'completion_tokens']);
  const cachedRead = firstNum(info, ['cached_input_tokens', 'cachedReadTokens', 'cache_read_input_tokens']);
  const cachedWrite = firstNum(info, ['cache_creation_input_tokens', 'cachedWriteTokens']);
  const explicitTotal = firstNum(info, ['total_tokens', 'totalTokens']);
  const reasoningOutput = firstNum(info, ['reasoning_output_tokens', 'reasoningOutputTokens']);

  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (cachedRead !== undefined) usage.cachedReadTokens = cachedRead;
  if (cachedWrite !== undefined) usage.cachedWriteTokens = cachedWrite;
  if (explicitTotal !== undefined) {
    usage.totalTokens = explicitTotal;
  } else if (reasoningOutput !== undefined) {
    const total = (input ?? 0) + (output ?? 0) + (reasoningOutput ?? 0);
    if (total > 0) usage.totalTokens = total;
  }
  return usage;
}

function blockText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const item = asRecord(c);
        return item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(c);
      })
      .join('\n');
  }
  return typeof content === 'string' ? content : '';
}

function firstTokenStatus(state: JsonMapperState): AgentEvent[] {
  if (state.sentFirstToken) return [];
  state.sentFirstToken = true;
  return [{ type: 'status', label: 'streaming', ttftMs: state.now() - state.startedAt }];
}

/** Map Claude Code `--output-format stream-json` events. */
export const claudeStreamJsonMapper: JsonEventMapper = (raw, state) => {
  const obj = asRecord(raw);
  if (!obj) return [];
  const out: AgentEvent[] = [];

  if (obj.type === 'system') {
    out.push({ type: 'status', label: 'working' });
    return out;
  }

  if (obj.type === 'stream_event') {
    const event = asRecord(obj.event);
    if (event?.type === 'content_block_delta') {
      const delta = asRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        out.push(...firstTokenStatus(state));
        state.streamedText = true;
        out.push({ type: 'text_delta', delta: delta.text });
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        out.push({ type: 'thinking_delta', delta: delta.thinking });
      }
    }
    return out;
  }

  if (obj.type === 'assistant') {
    const content = asRecord(obj.message)?.content;
    if (Array.isArray(content)) {
      for (const blockRaw of content) {
        const block = asRecord(blockRaw);
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          if (!state.streamedText) out.push({ type: 'text_delta', delta: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          if (!state.streamedText) out.push({ type: 'thinking_delta', delta: block.thinking });
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'tool_use',
            id: typeof block.id === 'string' ? block.id : null,
            name: typeof block.name === 'string' ? block.name : null,
            input: block.input ?? null,
          });
        }
      }
    }
    return out;
  }

  if (obj.type === 'user') {
    const content = asRecord(obj.message)?.content;
    if (Array.isArray(content)) {
      for (const blockRaw of content) {
        const block = asRecord(blockRaw);
        if (block?.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
            content: blockText(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }
    return out;
  }

  if (obj.type === 'result') {
    const usageRaw = asRecord(obj.usage);
    if (usageRaw) {
      const usage: TokenUsage = {};
      if (num(usageRaw.input_tokens) !== undefined) usage.inputTokens = num(usageRaw.input_tokens);
      if (num(usageRaw.output_tokens) !== undefined) usage.outputTokens = num(usageRaw.output_tokens);
      if (num(usageRaw.cache_read_input_tokens) !== undefined) {
        usage.cachedReadTokens = num(usageRaw.cache_read_input_tokens);
      }
      if (num(usageRaw.cache_creation_input_tokens) !== undefined) {
        usage.cachedWriteTokens = num(usageRaw.cache_creation_input_tokens);
      }
      out.push({ type: 'usage', usage, costUsd: num(obj.total_cost_usd) ?? null });
    }
    if ((obj.subtype && obj.subtype !== 'success') || obj.is_error === true) {
      out.push({
        type: 'error',
        message: typeof obj.result === 'string' ? obj.result : 'Claude run error',
        raw: obj,
      });
    }
    return out;
  }

  return out;
};

/** Map Codex `exec --json` events (tolerant of both `msg`- and `item`-shaped streams). */
export const codexJsonMapper: JsonEventMapper = (raw, state) => {
  const obj = asRecord(raw);
  if (!obj) return [];
  const out: AgentEvent[] = [];

  // Newer Codex: { type: 'item.completed', item: { type, text } }.
  if ((obj.type === 'item.completed' || obj.type === 'item.started') && asRecord(obj.item)) {
    const item = asRecord(obj.item)!;
    const it = item.type;
    // Codex fires BOTH item.started and item.completed for the SAME item id.
    // Dedup EVERY item kind by id so a single message / reasoning block / tool
    // call is emitted once; distinct items (different id) are still each emitted.
    const id = typeof item.id === 'string' ? item.id : undefined;
    const seenById = id ? (state.emittedItemIds?.has(id) ?? false) : false;
    const markSeen = (): void => {
      if (id) (state.emittedItemIds ??= new Set()).add(id);
    };
    if ((it === 'agent_message' || it === 'assistant_message') && typeof item.text === 'string') {
      // Distinct messages with no id fall back to last-text comparison.
      const isRepeat = id ? seenById : item.text === state.lastMessageText;
      if (!isRepeat) {
        out.push(...firstTokenStatus(state));
        state.streamedText = true;
        state.lastMessageText = item.text;
        markSeen();
        out.push({ type: 'text_delta', delta: item.text });
      }
    } else if (it === 'reasoning' && typeof item.text === 'string') {
      if (!seenById) {
        markSeen();
        out.push({ type: 'thinking_delta', delta: item.text });
      }
    } else if (it === 'command_execution' || it === 'tool_call') {
      if (!seenById) {
        markSeen();
        out.push({
          type: 'tool_use',
          id: id ?? null,
          name: typeof item.command === 'string' ? item.command : (it as string),
          input: item.command ?? item.input ?? null,
        });
      }
    }
    return out;
  }

  // Older Codex: { msg: { type, ... } }.
  const msg = asRecord(obj.msg) ?? obj;
  const t = typeof msg.type === 'string' ? msg.type : '';

  if (t === 'agent_message_delta' || t === 'assistant_message_delta') {
    if (typeof msg.delta === 'string' && msg.delta) {
      out.push(...firstTokenStatus(state));
      state.streamedText = true;
      out.push({ type: 'text_delta', delta: msg.delta });
    }
  } else if (t === 'agent_reasoning_delta' || t === 'reasoning_delta') {
    if (typeof msg.delta === 'string') out.push({ type: 'thinking_delta', delta: msg.delta });
  } else if (t === 'agent_message' || t === 'assistant_message') {
    const text =
      typeof msg.message === 'string' ? msg.message : typeof msg.text === 'string' ? msg.text : '';
    if (text && !state.streamedText) out.push({ type: 'text_delta', delta: text });
  } else if (t === 'token_count' || t === 'usage' || t === 'turn.completed') {
    const info = asRecord(msg.info) ?? asRecord(msg.usage) ?? msg;
    const usage = codexUsageFrom(info);
    if (Object.keys(usage).length > 0) out.push({ type: 'usage', usage });
  } else if (t === 'error' || t === 'stream_error') {
    out.push({
      type: 'error',
      message: typeof msg.message === 'string' ? msg.message : 'Codex error',
      raw: obj,
    });
  }
  return out;
};

const MAPPERS: Record<string, JsonEventMapper> = {
  'claude-stream-json': claudeStreamJsonMapper,
  'codex-json': codexJsonMapper,
};

/** Return the JSON mapper for a format, or null for non-JSON formats. */
export function getJsonMapper(format: StreamFormat): JsonEventMapper | null {
  return MAPPERS[format] ?? null;
}
