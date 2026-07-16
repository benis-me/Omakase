// Identifier helpers.

/** Full UUID (v4). */
export function uuid(): string {
  return crypto.randomUUID();
}

const ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz'; // no 0/1/l/o ambiguity

/** Short, url-safe, human-friendly id. Not cryptographically strong. */
export function shortId(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Prefixed short id, e.g. runId() -> "run_ab12cd34". */
export function runId(): string {
  return `run_${shortId(8)}`;
}

export function sessionId(): string {
  return `ses_${shortId(8)}`;
}

export function reportId(): string {
  return `rep_${shortId(6)}`;
}

export function agentCallId(): string {
  return `agt_${shortId(6)}`;
}
