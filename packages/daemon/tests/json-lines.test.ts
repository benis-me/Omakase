import { describe, expect, it } from 'vitest';
import {
  classifyJsonCandidate,
  createJsonLineStream,
} from '../src/protocol/json-lines.js';

function collect(chunks: string[], flush = true): unknown[] {
  const out: unknown[] = [];
  const stream = createJsonLineStream((msg) => out.push(msg));
  for (const chunk of chunks) stream.feed(chunk);
  if (flush) stream.flush();
  return out;
}

describe('classifyJsonCandidate', () => {
  it('detects complete, incomplete, and invalid candidates', () => {
    expect(classifyJsonCandidate('{"a":1}')).toBe('complete');
    expect(classifyJsonCandidate('{"a":1')).toBe('incomplete');
    expect(classifyJsonCandidate('{"a":"}"}')).toBe('complete');
    expect(classifyJsonCandidate('}}}')).toBe('invalid');
    expect(classifyJsonCandidate('   ')).toBe('incomplete');
  });

  it('ignores braces inside strings and escapes', () => {
    expect(classifyJsonCandidate('{"k":"a\\"{[("}')).toBe('complete');
  });
});

describe('createJsonLineStream', () => {
  it('parses one object per line', () => {
    expect(collect(['{"n":1}\n{"n":2}\n'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('handles a line split across multiple chunks', () => {
    expect(collect(['{"hel', 'lo":', '"world"}\n'])).toEqual([
      { hello: 'world' },
    ]);
  });

  it('flushes a trailing line with no newline', () => {
    expect(collect(['{"n":1}\n{"n":2}'])).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('aggregates a pretty-printed multi-line object', () => {
    expect(collect(['{\n', '  "a": 1,\n', '  "b": 2\n', '}\n'])).toEqual([
      { a: 1, b: 2 },
    ]);
  });

  it('drops non-JSON noise lines but keeps valid neighbours', () => {
    expect(collect(['not json\n', '{"ok":true}\n'])).toEqual([{ ok: true }]);
  });

  it('drops a runaway newline-less line and resyncs at the next newline', () => {
    // A child that streams megabytes without a newline must not grow the
    // internal buffer unbounded; the oversize fragment is dropped and parsing
    // resumes on the next clean line.
    const garbage = 'x'.repeat(5 * 1024 * 1024);
    const out = collect([garbage, '\n{"ok":true}\n']);
    expect(out).toEqual([{ ok: true }]);
  });
});
