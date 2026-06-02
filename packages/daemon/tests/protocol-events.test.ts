import { describe, expect, it } from 'vitest';
import {
  collectAgentResult,
  createResultAccumulator,
  isAgentEvent,
} from '../src/protocol/events.js';
import type { AgentEvent } from '../src/protocol/events.js';

const sample: AgentEvent[] = [
  { type: 'status', label: 'initializing', model: 'demo/model' },
  { type: 'status', label: 'streaming', ttftMs: 12 },
  { type: 'thinking_start' },
  { type: 'thinking_delta', delta: 'plan...' },
  { type: 'thinking_end' },
  { type: 'text_delta', delta: 'Hello' },
  { type: 'text_delta', delta: ', world' },
  { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
  { type: 'tool_result', toolUseId: 't1', content: 'file body', isError: false },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.01 },
  { type: 'done', reason: 'completed' },
];

describe('createResultAccumulator', () => {
  it('folds a full event stream into a result', () => {
    const acc = createResultAccumulator();
    for (const e of sample) acc.push(e);
    const r = acc.result();
    expect(r.text).toBe('Hello, world');
    expect(r.thinking).toBe('plan...');
    expect(r.model).toBe('demo/model');
    expect(r.status).toBe('completed');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(r.costUsd).toBe(0.01);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.result).toEqual({
      content: 'file body',
      isError: false,
    });
  });

  it('reports error status when an error event precedes done', () => {
    const acc = createResultAccumulator();
    acc.push({ type: 'text_delta', delta: 'partial' });
    acc.push({ type: 'error', message: 'boom' });
    const r = acc.result();
    expect(r.status).toBe('error');
    expect(r.error).toBe('boom');
    expect(r.text).toBe('partial');
  });

  it('defaults to completed when the stream ends without done', () => {
    const acc = createResultAccumulator();
    acc.push({ type: 'text_delta', delta: 'x' });
    expect(acc.result().status).toBe('completed');
  });
});

describe('collectAgentResult', () => {
  it('drains an async stream', async () => {
    async function* gen(): AsyncGenerator<AgentEvent> {
      for (const e of sample) yield e;
    }
    const r = await collectAgentResult(gen());
    expect(r.text).toBe('Hello, world');
    expect(r.status).toBe('completed');
  });
});

describe('isAgentEvent', () => {
  it('narrows event variants', () => {
    const e: AgentEvent = { type: 'text_delta', delta: 'hi' };
    expect(isAgentEvent(e, 'text_delta')).toBe(true);
    expect(isAgentEvent(e, 'tool_use')).toBe(false);
  });
});
