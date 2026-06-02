import { describe, expect, it } from 'vitest';
import {
  claudeStreamJsonMapper,
  codexJsonMapper,
  type JsonMapperState,
} from '../src/runtime/parsers.js';
import { mapPiRpcEvent, type PiMapperState } from '../src/protocol/pi-rpc.js';
import { createResultAccumulator } from '../src/protocol/events.js';
import type { AgentEvent } from '../src/protocol/events.js';

function jsonState(): JsonMapperState {
  return { startedAt: 0, sentFirstToken: false, streamedText: false, now: () => 1 };
}

function fold(events: AgentEvent[]) {
  const acc = createResultAccumulator();
  for (const e of events) acc.push(e);
  return acc.result();
}

describe('claudeStreamJsonMapper', () => {
  it('maps a full non-streaming turn', () => {
    const state = jsonState();
    const events: AgentEvent[] = [];
    const lines = [
      { type: 'system', subtype: 'init' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'body', is_error: false }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.02,
        usage: { input_tokens: 5, output_tokens: 3 },
      },
    ];
    for (const line of lines) events.push(...claudeStreamJsonMapper(line, state));
    const r = fold(events);
    expect(r.text).toBe('Hello');
    expect(r.toolCalls[0]).toMatchObject({ name: 'read_file' });
    expect(r.toolCalls[0]?.result).toEqual({ content: 'body', isError: false });
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(r.costUsd).toBe(0.02);
  });

  it('suppresses the final text block when partial deltas streamed', () => {
    const state = jsonState();
    const events: AgentEvent[] = [];
    events.push(
      ...claudeStreamJsonMapper(
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } } },
        state,
      ),
    );
    events.push(
      ...claudeStreamJsonMapper(
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } } },
        state,
      ),
    );
    events.push(
      ...claudeStreamJsonMapper(
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }] } },
        state,
      ),
    );
    expect(fold(events).text).toBe('Hi there');
  });

  it('emits an error event on a non-success result', () => {
    const events = claudeStreamJsonMapper(
      { type: 'result', subtype: 'error_max_turns', result: 'too many turns' },
      jsonState(),
    );
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});

describe('codexJsonMapper', () => {
  it('maps msg-shaped deltas and usage', () => {
    const state = jsonState();
    const events: AgentEvent[] = [];
    events.push(...codexJsonMapper({ msg: { type: 'agent_message_delta', delta: 'foo ' } }, state));
    events.push(...codexJsonMapper({ msg: { type: 'agent_message_delta', delta: 'bar' } }, state));
    events.push(
      ...codexJsonMapper({ msg: { type: 'token_count', info: { input_tokens: 9, output_tokens: 4 } } }, state),
    );
    const r = fold(events);
    expect(r.text).toBe('foo bar');
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });

  it('maps item.completed-shaped messages', () => {
    const events = codexJsonMapper(
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      jsonState(),
    );
    expect(fold(events).text).toBe('done');
  });

  it('does not duplicate text across item.started and item.completed', () => {
    const state = jsonState();
    const events: AgentEvent[] = [];
    events.push(...codexJsonMapper({ type: 'item.started', item: { type: 'agent_message', text: 'hello' } }, state));
    events.push(...codexJsonMapper({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }, state));
    expect(fold(events).text).toBe('hello');
  });
});

describe('mapPiRpcEvent', () => {
  function piState(): PiMapperState {
    return { startedAt: 0, sentFirstToken: false, now: () => 2 };
  }

  it('maps a turn and signals end on agent_end', () => {
    const state = piState();
    const events: AgentEvent[] = [];
    let ended = false;
    const seq = [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } },
      {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { cmd: 'ls' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: { content: [{ type: 'text', text: 'a.ts' }] },
      },
      { type: 'turn_end', message: { usage: { input: 10, output: 5, cost: { total: 0.01 } } } },
      { type: 'agent_end' },
    ];
    for (const raw of seq) {
      const res = mapPiRpcEvent(raw, state);
      events.push(...res.events);
      if (res.ended) ended = true;
    }
    expect(ended).toBe(true);
    const r = fold(events);
    expect(r.text).toBe('Hi');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(r.costUsd).toBe(0.01);
    expect(r.toolCalls[0]?.result?.content).toBe('a.ts');
  });
});
