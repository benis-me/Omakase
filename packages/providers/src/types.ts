// Provider abstraction: detect and drive installed AI agent CLIs.
//
// A Provider knows how to (a) build the argv/stdin to run one turn of an agent
// CLI headlessly, and (b) parse that CLI's output stream into activities and a
// final result. The unified runner (runner.ts) does the spawning and streaming.

import type { AgentActivity } from '@omakase/core';

/** Everything a provider needs to construct one headless turn. */
export interface TurnContext {
  /** The user/task prompt. */
  prompt: string;
  /** System/role prompt; providers without a flag prepend it to the prompt. */
  systemPrompt?: string;
  /** Working directory the agent edits. */
  cwd: string;
  /** Model id, if chosen. */
  model?: string;
  /** Native session id to resume (provider-specific). */
  resumeSessionId?: string;
  /** A pre-minted session id the runner would like the provider to adopt
   *  (Claude supports --session-id; others ignore it and report their own). */
  plannedSessionId?: string;
  /** Auto-approve all tool actions (yolo). Defaults true for orchestration. */
  autoApprove: boolean;
  /** A scratch file path the provider may use for last-message capture. */
  scratchFile: string;
}

/** How the runner should interpret a provider's stdout. */
export type OutputFormat =
  | 'claude-stream-json'
  | 'codex-json'
  | 'cursor-stream-json'
  | 'gemini-json'
  | 'text-tail';

/** A concrete plan to spawn one turn. */
export interface SpawnPlan {
  /** Argv after the command binary. */
  args: string[];
  /** If set, written to the child's stdin then closed. */
  stdin?: string;
  /** Output interpretation strategy. */
  outputFormat: OutputFormat;
  /** If the provider writes its final message to a file, its path. */
  lastMessageFile?: string;
}

export interface AgentTurnResult {
  text: string;
  status: 'ok' | 'error';
  /** Native session id captured from the stream, for later --resume. */
  providerSessionId: string | null;
  activities: AgentActivity[];
  tokens: number;
  costUsd: number;
  durationMs: number;
  exitCode: number;
  /** Trimmed raw stdout tail, for debugging. */
  rawTail: string;
}

/** A stateful, per-turn stream parser. */
export interface StreamParser {
  /** Consume one whole stdout line. Return activities to emit live. */
  onLine(line: string): AgentActivity[];
  /** Assemble the final result after the process exits. */
  finalize(input: {
    exitCode: number;
    stderrTail: string;
    lastMessageFileContent?: string;
  }): Omit<AgentTurnResult, 'activities' | 'durationMs'>;
}

export interface AgentProvider {
  /** Stable id, matches the binary base name (e.g. "claude"). */
  id: string;
  /** Default binary on PATH. */
  command: string;
  /** Human label. */
  label: string;
  /** Fallback model list when discovery yields nothing. */
  seedModels: string[];
  /** A fast/cheap model for quick passes, if any. */
  fastModel?: string;
  /** Build the spawn plan for a turn. */
  plan(ctx: TurnContext): SpawnPlan;
  /** Create a fresh parser for a turn. */
  createParser(): StreamParser;
  /** Environment variable names carrying this provider's API key. */
  apiKeyEnv?: string[];
  /** Probe the CLI for its real model list (empty when unavailable). */
  discoverModels?(command: string): Promise<string[]>;
}

/** Result of detecting one provider on the machine. */
export interface ProviderInfo {
  id: string;
  command: string;
  label: string;
  available: boolean;
  version: string | null;
  path: string | null;
  models: string[];
  fastModel?: string;
}
