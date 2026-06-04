/**
 * Adapter stream-conformance: recorded representative CLI output (the .jsonl /
 * .txt files under fixtures/) replayed through the exact parser path the
 * executors use, asserting the folded result. These pin argv/stream mapping so
 * a parser change that breaks a real adapter shows up as a failed fixture.
 *
 * To refresh against a new CLI release, capture its stdout for a simple turn
 * and drop it in as the matching fixture.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createJsonLineStream } from '../src/protocol/json-lines.js';
import { getJsonMapper, type JsonMapperState } from '../src/runtime/parsers.js';
import { mapPiRpcEvent, type PiMapperState } from '../src/protocol/pi-rpc.js';
import { createResultAccumulator } from '../src/protocol/events.js';
import type { AgentEvent } from '../src/protocol/events.js';

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function fold(events: AgentEvent[]) {
  const acc = createResultAccumulator();
  for (const e of events) acc.push(e);
  return acc.result();
}

/** Replay a JSONL fixture through createJsonLineStream + the format's mapper. */
function replayJson(format: string, text: string): AgentEvent[] {
  const mapper = getJsonMapper(format);
  if (!mapper) throw new Error(`no mapper for ${format}`);
  const state: JsonMapperState = { startedAt: 0, sentFirstToken: false, streamedText: false, now: () => 1 };
  const events: AgentEvent[] = [];
  const stream = createJsonLineStream((raw) => {
    for (const e of mapper(raw, state)) events.push(e);
  });
  stream.feed(text);
  stream.flush();
  return events;
}

function replayPiRpc(text: string): AgentEvent[] {
  const state: PiMapperState = { startedAt: 0, sentFirstToken: false, now: () => 1 };
  const events: AgentEvent[] = [];
  const stream = createJsonLineStream((raw) => {
    for (const e of mapPiRpcEvent(raw, state).events) events.push(e);
  });
  stream.feed(text);
  stream.flush();
  return events;
}

describe('adapter stream conformance', () => {
  it('claude-stream-json: text + tool call + usage + cost', () => {
    const r = fold(replayJson('claude-stream-json', fixture('claude-stream-json.jsonl')));
    expect(r.text).toBe('Reading the README to summarize. It is the Omakase project.');
    expect(r.toolCalls.map((t) => t.name)).toEqual(['read']);
    expect(r.toolCalls[0]?.result?.content).toBe('# Omakase');
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 42 });
    expect(r.costUsd).toBe(0.0123);
  });

  it('codex-json: item dedup + tool call + token count', () => {
    const r = fold(replayJson('codex-json', fixture('codex-json.jsonl')));
    expect(r.text).toBe('Let me check the files. Done — 3 files.');
    expect(r.toolCalls).toHaveLength(1); // command_execution, emitted once
    expect(r.usage).toEqual({ inputTokens: 900, outputTokens: 30 });
  });

  it('pi-rpc: streamed text + tool result + usage + cost', () => {
    const r = fold(replayPiRpc(fixture('pi-rpc.jsonl')));
    expect(r.text).toBe('Pi summary.');
    expect(r.toolCalls[0]?.result?.content).toBe('a.ts\nb.ts');
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 12 });
    expect(r.costUsd).toBe(0.004);
  });

  it('plain-text: no JSON mapper — stdout streams straight through as text', () => {
    expect(getJsonMapper('plain-text')).toBeNull();
    const text = fixture('plain-text.txt');
    const r = fold([{ type: 'text_delta', delta: text }]);
    expect(r.text).toContain('TypeScript agent runtime monorepo');
  });
});
