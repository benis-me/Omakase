/**
 * Detect when an agent CLI hit a usage / rate limit, and when it resets. A limit is
 * not a normal failure — retrying immediately just burns attempts on something only
 * time fixes — so the orchestrator stops and resumes after the reset (see RunHost).
 *
 * Message shapes vary by CLI (Claude Code: "Claude usage limit reached. Your limit
 * will reset at 3pm", "5-hour limit reached - resets …"; OpenAI/codex: 429 /
 * "exceeded your current quota" / "Please try again in 20s"; API: `retry-after`),
 * so detection is a keyword match plus a best-effort reset-time parse.
 */

/** Fallback wait when a limit is detected but no reset time can be parsed. */
export const RATE_LIMIT_DEFAULT_BACKOFF_MS = 60 * 60 * 1000; // 1 hour

export interface RateLimitInfo {
  /** Wall-clock ms when the limit resets, or null when unparseable (caller backs off). */
  resetAt: number | null;
  /** The matched message (collapsed + trimmed) for surfacing to the user. */
  raw: string;
}

const LIMIT_RE =
  /(usage limit reached|rate[ -]?limit(?:ed|s)?|5-?hour limit|weekly limit|limit reached|too many requests|\b429\b|exceeded your (?:current )?quota|usage cap|out of (?:usage|credits)|insufficient_quota|overloaded_error|model is overloaded)/i;

/** A usage/rate-limit message in agent output, with the reset time if present. */
export function detectRateLimit(text: string, now: number): RateLimitInfo | null {
  if (!text || !LIMIT_RE.test(text)) return null;
  return { resetAt: parseResetTime(text, now), raw: text.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  second: 1000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
};

/** Best-effort: turn a reset phrase into an absolute wall-clock ms, or null. */
export function parseResetTime(text: string, now: number): number | null {
  // "try again in 20s" / "resets in 5 minutes" / "retry after 2 hours"
  const dur = /(?:retry[- ]?after|try again (?:in|after)|resets? in|reset in|wait)\D{0,8}(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smhd])\b/i.exec(
    text,
  );
  if (dur) {
    const n = parseInt(dur[1], 10);
    const unit = dur[2].toLowerCase().replace(/s$/, '');
    const ms = UNIT_MS[unit] ?? UNIT_MS[unit.slice(0, 3)] ?? UNIT_MS[unit[0]];
    if (ms) return now + n * ms;
  }
  // Header style: "retry-after: 120"
  const ra = /retry[- ]?after["':\s]+(\d+)\b/i.exec(text);
  if (ra) return now + parseInt(ra[1], 10) * 1000;
  // A unix timestamp (10-digit seconds or 13-digit ms), e.g. from stream-json.
  const ts = /\b(1[6-9]\d{8}|1[6-9]\d{11})\b/.exec(text);
  if (ts) {
    const v = parseInt(ts[1], 10);
    return v < 1e12 ? v * 1000 : v;
  }
  // Clock time: "reset at 3pm" / "try again after 15:30" → the next occurrence.
  const clock = /(?:resets?(?:\s+at)?|try again (?:at|after)|will reset at)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(
    text,
  );
  if (clock) {
    return nextClockTime(now, parseInt(clock[1], 10), clock[2] ? parseInt(clock[2], 10) : 0, clock[3]?.toLowerCase());
  }
  return null;
}

/** The next wall-clock occurrence of HH:MM (local time) at or after `now`. */
function nextClockTime(now: number, hour: number, minute: number, meridiem?: string): number {
  let h = hour % 24;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  const target = new Date(now);
  target.setHours(h, minute, 0, 0);
  if (target.getTime() <= now) target.setTime(target.getTime() + 86_400_000); // tomorrow
  return target.getTime();
}
