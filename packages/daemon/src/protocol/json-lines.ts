/**
 * Line-delimited JSON (JSONL) parsing for agent stdout streams.
 *
 * Agent CLIs emit one JSON object per line, but a few bridges pretty-print
 * their handshake across several lines during startup. This parser handles
 * the common case (one object per line) and transparently re-aggregates a
 * bounded run of lines when a single line does not parse on its own.
 */

export type JsonCandidateState = 'complete' | 'incomplete' | 'invalid';

/**
 * Cheap structural classification of a candidate JSON string. The real source
 * of truth is `JSON.parse`; this only decides whether it is worth buffering
 * more input before giving up on a line.
 */
export function classifyJsonCandidate(input: string): JsonCandidateState {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let sawValue = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    switch (ch) {
      case '"':
        inString = true;
        sawValue = true;
        break;
      case '{':
      case '[':
        depth += 1;
        sawValue = true;
        break;
      case '}':
      case ']':
        depth -= 1;
        if (depth < 0) return 'invalid';
        break;
      case ' ':
      case '\t':
      case '\n':
      case '\r':
        break;
      default:
        sawValue = true;
        break;
    }
  }

  if (inString || depth > 0) return 'incomplete';
  return sawValue ? 'complete' : 'incomplete';
}

export interface JsonLineStream {
  /** Feed a chunk of stdout text; emits a message per parsed line. */
  feed(chunk: string): void;
  /** Flush any buffered trailing line at end-of-stream. */
  flush(): void;
}

const MAX_AGGREGATE_BYTES = 256 * 1024;
const MAX_AGGREGATE_LINES = 512;
/** Hard cap on a single not-yet-terminated line before we drop it and resync. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/**
 * Create a streaming JSONL parser.
 *
 * @param onMessage Called with the parsed value and the raw line text for each
 *   successfully parsed object. Non-JSON lines are dropped silently unless they
 *   look like the start of a multi-line JSON value, in which case a bounded
 *   number of subsequent lines are aggregated and retried.
 */
export function createJsonLineStream(
  onMessage: (message: unknown, rawLine: string) => void,
): JsonLineStream {
  let buffer = '';
  let pending = '';
  let pendingLineCount = 0;

  const emit = (candidate: string): boolean => {
    try {
      onMessage(JSON.parse(candidate), candidate);
      return true;
    } catch {
      return false;
    }
  };

  const resetPending = (): void => {
    pending = '';
    pendingLineCount = 0;
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (pending) {
      const candidate = `${pending}\n${trimmed}`;
      if (emit(candidate)) {
        resetPending();
        return;
      }
      pendingLineCount += 1;
      const state = classifyJsonCandidate(candidate);
      if (
        state === 'incomplete' &&
        candidate.length <= MAX_AGGREGATE_BYTES &&
        pendingLineCount <= MAX_AGGREGATE_LINES
      ) {
        pending = candidate;
        return;
      }
      // Give up on the aggregate and reinterpret the current line fresh.
      resetPending();
      handleLine(trimmed);
      return;
    }

    if (emit(trimmed)) return;

    if (
      (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
      classifyJsonCandidate(trimmed) === 'incomplete'
    ) {
      pending = trimmed;
      pendingLineCount = 1;
    }
  };

  return {
    feed(chunk: string): void {
      buffer += chunk;
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        handleLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
      // Guard against an unbounded line: a process that streams without a
      // newline (or a multi-MB single line) must not grow `buffer` forever.
      // Drop the oversize in-progress line and resync at the next newline.
      if (buffer.length > MAX_LINE_BYTES) {
        resetPending();
        buffer = '';
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        handleLine(buffer);
        buffer = '';
      }
      if (pending) {
        // A trailing incomplete aggregate at EOF is unrecoverable; drop it.
        resetPending();
      }
    },
  };
}
