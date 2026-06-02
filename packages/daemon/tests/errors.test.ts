import { describe, expect, it } from 'vitest';
import {
  AgentCancelledError,
  AgentNotInstalledError,
  AgentRuntimeError,
  AgentTimeoutError,
  PromptTooLargeError,
  errnoCode,
  isAgentRuntimeError,
} from '../src/runtime/errors.js';

describe('runtime errors', () => {
  it('carries a discriminable code and agent id', () => {
    const err = new AgentNotInstalledError('codex');
    expect(err.code).toBe('not_installed');
    expect(err.agentId).toBe('codex');
    expect(err.message).toContain('codex');
    expect(err).toBeInstanceOf(AgentRuntimeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AgentNotInstalledError');
  });

  it('is recognised by the type guard', () => {
    expect(isAgentRuntimeError(new AgentCancelledError())).toBe(true);
    expect(isAgentRuntimeError(new Error('plain'))).toBe(false);
  });

  it('keeps subclass-specific detail', () => {
    const timeout = new AgentTimeoutError(5000);
    expect(timeout.timeoutMs).toBe(5000);
    expect(timeout.code).toBe('timeout');

    const big = new PromptTooLargeError(200_000, 128_000);
    expect(big.bytes).toBe(200_000);
    expect(big.limit).toBe(128_000);
  });

  it('extracts errno codes from arbitrary errors', () => {
    expect(errnoCode({ code: 'ENOENT' })).toBe('ENOENT');
    expect(errnoCode(new Error('x'))).toBeUndefined();
    expect(errnoCode(42)).toBeUndefined();
  });
});
