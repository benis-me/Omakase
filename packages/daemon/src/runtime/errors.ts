/**
 * Typed errors for the agent runtime. Every failure mode the execution layer
 * can surface has a discriminable `code` and a dedicated subclass so callers
 * can branch on `instanceof` or on `error.code` without string matching.
 */

export type AgentErrorCode =
  | 'not_installed'
  | 'auth_missing'
  | 'spawn_failed'
  | 'protocol_error'
  | 'timeout'
  | 'cancelled'
  | 'prompt_too_large'
  | 'unknown';

export interface AgentRuntimeErrorOptions {
  agentId?: string;
  cause?: unknown;
  /** Arbitrary structured detail for diagnostics. */
  detail?: Record<string, unknown>;
}

export class AgentRuntimeError extends Error {
  readonly code: AgentErrorCode;
  readonly agentId: string | undefined;
  override readonly cause: unknown;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: AgentRuntimeErrorOptions = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.agentId = options.agentId;
    this.cause = options.cause;
    this.detail = options.detail;
    // Maintain a clean prototype chain across the TS down-level transpile.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AgentNotInstalledError extends AgentRuntimeError {
  constructor(agentId: string, message?: string, options: AgentRuntimeErrorOptions = {}) {
    super('not_installed', message ?? `Agent "${agentId}" is not installed`, {
      ...options,
      agentId,
    });
  }
}

export class AgentAuthMissingError extends AgentRuntimeError {
  constructor(agentId: string, message?: string, options: AgentRuntimeErrorOptions = {}) {
    super(
      'auth_missing',
      message ?? `Agent "${agentId}" is not authenticated`,
      { ...options, agentId },
    );
  }
}

export class AgentSpawnError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super('spawn_failed', message, options);
  }
}

export class AgentProtocolError extends AgentRuntimeError {
  constructor(message: string, options: AgentRuntimeErrorOptions = {}) {
    super('protocol_error', message, options);
  }
}

export class AgentTimeoutError extends AgentRuntimeError {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, message?: string, options: AgentRuntimeErrorOptions = {}) {
    super('timeout', message ?? `Agent timed out after ${timeoutMs}ms`, options);
    this.timeoutMs = timeoutMs;
  }
}

export class AgentCancelledError extends AgentRuntimeError {
  constructor(message = 'Agent run was cancelled', options: AgentRuntimeErrorOptions = {}) {
    super('cancelled', message, options);
  }
}

export class PromptTooLargeError extends AgentRuntimeError {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number, options: AgentRuntimeErrorOptions = {}) {
    super(
      'prompt_too_large',
      `Prompt is ${bytes} bytes, exceeding the ${limit}-byte limit`,
      options,
    );
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function isAgentRuntimeError(value: unknown): value is AgentRuntimeError {
  return value instanceof AgentRuntimeError;
}

/** Best-effort extraction of a Node `errno` string code from an unknown error. */
export function errnoCode(value: unknown): string | undefined {
  if (value && typeof value === 'object' && 'code' in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
