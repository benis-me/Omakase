/**
 * Detect dev-server URLs and "port already in use" errors in terminal output.
 * Ported from DevDock (UrlDetector + shared/port).
 */

// Matches CSI ([…) and OSC (]…, incl. terminal hyperlinks) escape sequences.
const ANSI_REGEX = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);

const URL_REGEX =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost)(?::\d+)?(?:\/[^\s]*)?/gi;

const CONFLICT_PATTERNS: readonly RegExp[] = [
  /EADDRINUSE[^\n]*?(?:::::?|[\d.]*:)(\d{2,5})\b/i,
  /address already in use[^\n]*?:(\d{2,5})\b/i,
  /\bport\s+(\d{2,5})\s+is\s+(?:already\s+)?in use/i,
  /already running on port\s+(\d{2,5})/i,
];

export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '');
}

export function detectUrl(input: string): string | null {
  const text = stripAnsi(input);
  for (const line of text.split(/\r?\n/)) {
    if (/local/i.test(line)) {
      const m = line.match(URL_REGEX);
      if (m && m.length) return m[0];
    }
  }
  const all = text.match(URL_REGEX);
  return all && all.length ? all[0] : null;
}

export function detectPortConflict(text: string): number | null {
  for (const re of CONFLICT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 65535) return n;
    }
  }
  return null;
}
