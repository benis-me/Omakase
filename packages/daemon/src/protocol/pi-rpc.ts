/**
 * Pi `--mode rpc` protocol mapping.
 *
 * Pi drives the whole turn over stdio JSON-RPC: the daemon sends a `prompt`
 * command and pi streams typed events back (agent_start, message_update,
 * tool_execution_*, turn_end, agent_end, …). This module is the *pure* mapping
 * from those raw events to {@link AgentEvent}s plus a couple of small helpers
 * for the interactive bits (auto-resolving extension-UI dialogs). The session
 * loop that owns stdin/stdout lives in `runtime/executors/pi-rpc.ts`.
 */
import type { AgentEvent, TokenUsage } from './events.js';

type JsonRecord = Record<string, unknown>;

export interface PiMapperState {
  startedAt: number;
  sentFirstToken: boolean;
  now(): number;
}

export interface PiMapResult {
  events: AgentEvent[];
  /** True when pi signalled `agent_end` — the turn is complete. */
  ended: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

const FIRE_AND_FORGET_METHODS = new Set([
  'setStatus',
  'setWidget',
  'notify',
  'setTitle',
  'set_editor_text',
]);

/** True if the raw event is an extension-UI request that expects a reply. */
export function isExtensionUiRequest(raw: unknown): raw is JsonRecord {
  return isRecord(raw) && raw.type === 'extension_ui_request' && raw.id != null;
}

/**
 * Build the auto-resolution reply for an extension-UI request. We have no
 * interactive surface, so confirms resolve true and selects pick the first
 * option; fire-and-forget methods get no reply (returns null).
 */
export function buildExtensionUiResponse(raw: JsonRecord): string | null {
  if (typeof raw.method === 'string' && FIRE_AND_FORGET_METHODS.has(raw.method)) {
    return null;
  }
  let result: JsonRecord;
  if (raw.method === 'confirm') {
    result = { confirmed: true };
  } else {
    const params = asRecord(raw.params);
    const options = params?.options ?? (raw as JsonRecord).options;
    if (Array.isArray(options) && options.length > 0) {
      const first = options[0];
      result =
        typeof first === 'string'
          ? { value: first }
          : { value: asRecord(first)?.label ?? asRecord(first)?.value ?? '' };
    } else {
      result = { cancelled: true };
    }
  }
  return `${JSON.stringify({ type: 'extension_ui_response', id: raw.id, ...result })}\n`;
}

/** Serialize the `prompt` RPC command pi expects on stdin. */
export function buildPiPromptCommand(
  id: number,
  prompt: string,
  images?: Array<{ data: string; mimeType: string }>,
): string {
  const command: JsonRecord = { id, type: 'prompt', message: prompt };
  if (images && images.length > 0) {
    command.images = images.map((img) => ({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType,
    }));
  }
  return `${JSON.stringify(command)}\n`;
}

export function buildPiAbortCommand(id: number): string {
  return `${JSON.stringify({ id, type: 'abort' })}\n`;
}

/** Map one raw pi RPC event to zero or more {@link AgentEvent}s. */
export function mapPiRpcEvent(raw: unknown, state: PiMapperState): PiMapResult {
  const events: AgentEvent[] = [];
  if (!isRecord(raw)) return { events, ended: false };

  switch (raw.type) {
    case 'agent_start':
      events.push({ type: 'status', label: 'working' });
      return { events, ended: false };
    case 'agent_end':
      return { events, ended: true };
    case 'turn_start':
      events.push({ type: 'status', label: 'thinking' });
      return { events, ended: false };
    case 'compaction_start':
      events.push({ type: 'status', label: 'compacting' });
      return { events, ended: false };
    case 'auto_retry_start':
      events.push({ type: 'status', label: 'retrying' });
      return { events, ended: false };
    case 'tool_execution_start':
      events.push({
        type: 'tool_use',
        id: typeof raw.toolCallId === 'string' ? raw.toolCallId : null,
        name: typeof raw.toolName === 'string' ? raw.toolName : null,
        input: raw.args ?? null,
      });
      return { events, ended: false };
    case 'extension_error':
      events.push({
        type: 'error',
        message:
          typeof raw.error === 'string' && raw.error ? raw.error : 'Extension error',
        raw,
      });
      return { events, ended: false };
    default:
      break;
  }

  if (raw.type === 'auto_retry_end' && raw.success === false) {
    events.push({
      type: 'error',
      message:
        typeof raw.finalError === 'string' && raw.finalError
          ? raw.finalError
          : 'Auto-retry exhausted',
      raw,
    });
    return { events, ended: false };
  }

  if (raw.type === 'turn_end') {
    const message = asRecord(raw.message);
    const u = asRecord(message?.usage);
    if (u) {
      const usage: TokenUsage = {};
      if (num(u.input) !== undefined) usage.inputTokens = num(u.input);
      if (num(u.output) !== undefined) usage.outputTokens = num(u.output);
      if (num(u.cacheRead) !== undefined) usage.cachedReadTokens = num(u.cacheRead);
      if (num(u.cacheWrite) !== undefined) usage.cachedWriteTokens = num(u.cacheWrite);
      if (num(u.totalTokens) !== undefined) usage.totalTokens = num(u.totalTokens);
      if (Object.keys(usage).length > 0) {
        const cost = asRecord(u.cost);
        events.push({
          type: 'usage',
          usage,
          costUsd: (num(cost?.total) ?? num(cost?.totalCost)) ?? null,
          durationMs: state.now() - state.startedAt,
        });
      }
    }
    if (message?.stopReason === 'error') {
      events.push({
        type: 'error',
        message:
          typeof message.errorMessage === 'string' && message.errorMessage
            ? message.errorMessage
            : 'Pi agent error',
        raw,
      });
    }
    return { events, ended: false };
  }

  const ev = asRecord(raw.assistantMessageEvent);
  if (raw.type === 'message_update' && ev) {
    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      if (!state.sentFirstToken) {
        state.sentFirstToken = true;
        events.push({
          type: 'status',
          label: 'streaming',
          ttftMs: state.now() - state.startedAt,
        });
      }
      events.push({ type: 'text_delta', delta: ev.delta });
    } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') {
      events.push({ type: 'thinking_delta', delta: ev.delta });
    } else if (ev.type === 'thinking_start') {
      events.push({ type: 'thinking_start' });
    } else if (ev.type === 'thinking_end') {
      events.push({ type: 'thinking_end' });
    } else if (ev.type === 'error') {
      const reason =
        (typeof ev.reason === 'string' && ev.reason) ||
        (typeof ev.delta === 'string' && ev.delta) ||
        'Agent error';
      events.push({ type: 'error', message: reason, raw });
    }
    return { events, ended: false };
  }

  if (raw.type === 'tool_execution_end') {
    const result = asRecord(raw.result);
    const content = result?.content;
    const text = Array.isArray(content)
      ? content
          .map((c: unknown) => {
            const item = asRecord(c);
            return item?.type === 'text' ? String(item.text ?? '') : JSON.stringify(c);
          })
          .join('\n')
      : typeof content === 'string'
        ? content
        : '';
    events.push({
      type: 'tool_result',
      toolUseId: typeof raw.toolCallId === 'string' ? raw.toolCallId : null,
      content: text,
      isError: raw.isError === true,
    });
    return { events, ended: false };
  }

  return { events, ended: false };
}
