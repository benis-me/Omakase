import { describe, it, expect } from 'vitest';
import { detectRateLimit, parseResetTime } from '../src/rate-limit.js';

const NOW = 1_700_000_000_000;

describe('detectRateLimit', () => {
  it('detects usage/rate-limit messages from various CLIs', () => {
    expect(detectRateLimit('Claude usage limit reached. Your limit will reset at 3pm', NOW)).not.toBeNull();
    expect(detectRateLimit('5-hour limit reached - resets soon', NOW)).not.toBeNull();
    expect(detectRateLimit('Error: 429 Too Many Requests', NOW)).not.toBeNull();
    expect(detectRateLimit('You exceeded your current quota', NOW)).not.toBeNull();
    expect(detectRateLimit('rate limit exceeded, please try again later', NOW)).not.toBeNull();
  });

  it('is NOT triggered by ordinary output or errors', () => {
    expect(detectRateLimit('TypeError: cannot read property of undefined', NOW)).toBeNull();
    expect(detectRateLimit('All 12 tests passed', NOW)).toBeNull();
    expect(detectRateLimit('', NOW)).toBeNull();
  });

  it('carries the reset time when present', () => {
    const info = detectRateLimit('Rate limit hit. Please try again in 30 seconds.', NOW);
    expect(info?.resetAt).toBe(NOW + 30_000);
  });

  it("detects codex's actual usage-limit message + its 'try again at' clock time (live finding)", () => {
    const msg =
      "ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:04 PM.";
    const info = detectRateLimit(msg, NOW);
    expect(info).not.toBeNull(); // "hit your usage limit" must match (not only "usage limit reached")
    expect(typeof info?.resetAt).toBe('number'); // parsed "try again at 4:04 PM"
    expect(info?.resetAt).toBeGreaterThan(NOW);
  });
});

describe('parseResetTime', () => {
  it('parses relative durations', () => {
    expect(parseResetTime('please try again in 30 seconds', NOW)).toBe(NOW + 30_000);
    expect(parseResetTime('resets in 5 minutes', NOW)).toBe(NOW + 5 * 60_000);
    expect(parseResetTime('retry after 2 hours', NOW)).toBe(NOW + 2 * 3_600_000);
  });

  it('parses a retry-after header value (seconds)', () => {
    expect(parseResetTime('HTTP 429 retry-after: 120', NOW)).toBe(NOW + 120_000);
  });

  it('parses an absolute unix timestamp (seconds → ms)', () => {
    expect(parseResetTime('limit resets at 1800000000', NOW)).toBe(1_800_000_000 * 1000);
  });

  it('parses a clock time to a future moment', () => {
    const at = parseResetTime('Your limit will reset at 3pm', NOW);
    expect(typeof at).toBe('number');
    expect(at).toBeGreaterThan(NOW); // exact value is timezone-dependent
  });

  it('returns null when no reset time can be found', () => {
    expect(parseResetTime('usage limit reached', NOW)).toBeNull();
  });
});
