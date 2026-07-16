// Stream parsers: turn each provider's stdout into live activities + a final
// result. Parsers never throw — malformed lines are ignored.

import type { AgentActivity } from '@omakase/core';
import type { StreamParser, AgentTurnResult } from './types.ts';

type FinalCore = Omit<AgentTurnResult, 'activities' | 'durationMs'>;

function act(kind: AgentActivity['kind'], summary: string, tool?: string): AgentActivity {
  return tool ? { kind, summary, tool, at: Date.now() } : { kind, summary, at: Date.now() };
}

function tryJson(line: string): any | null {
  const s = line.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function firstString(obj: any, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

const NOISE_PATTERNS = [
  /^YOLO mode is enabled/i,
  /^Loaded cached credentials/i,
  /^\s*Data collection is/i,
  /^\s*\[dotenv/i,
];

/** True for known warning/log lines that are not agent output. */
export function isNoise(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

const RATE_LIMIT_PATTERNS = [
  /rate[\s_-]?limit/i,
  /\b429\b/,
  /too many requests/i,
  /overloaded/i,
  /\bquota\b/i,
  /retry[\s_-]?after/i,
  /capacity/i,
];

/** Heuristic: does this error text indicate a provider rate limit / overload? */
export function isRateLimit(text: string): boolean {
  return !!text && RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Summarize a tool_use into a human one-liner. */
export function toolSummary(name: string, input: any): string {
  const path = input?.file_path ?? input?.path ?? input?.filePath;
  switch (name) {
    case 'Write':
      return `Writing ${path ?? 'a file'}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${path ?? 'a file'}`;
    case 'Read':
      return `Reading ${path ?? 'a file'}`;
    case 'Bash': {
      const cmd = String(input?.command ?? '').split('\n')[0]!.slice(0, 80);
      return cmd ? `Running ${cmd}` : 'Running a command';
    }
    case 'Grep':
      return `Searching ${input?.pattern ? `"${String(input.pattern).slice(0, 40)}"` : ''}`.trim();
    default:
      return `Using ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Claude Code — precise stream-json parser
// ---------------------------------------------------------------------------

export class ClaudeStreamParser implements StreamParser {
  private text = '';
  private sessionId: string | null = null;
  private tokens = 0;
  private costUsd = 0;
  private isError = false;
  private sawResult = false;

  onLine(line: string): AgentActivity[] {
    const obj = tryJson(line);
    if (!obj) return [];
    const out: AgentActivity[] = [];
    const sid = firstString(obj, ['session_id']);
    if (sid) this.sessionId = sid;

    switch (obj.type) {
      case 'system':
        if (obj.subtype === 'init') out.push(act('notice', `Session ready${obj.model ? ` · ${obj.model}` : ''}`));
        break;
      case 'assistant': {
        const content = obj.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              this.text += block.text;
              const trimmed = block.text.trim();
              if (trimmed) out.push(act('text', trimmed.slice(0, 200)));
            } else if (block?.type === 'tool_use') {
              out.push(act('tool', toolSummary(block.name, block.input), block.name));
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
              out.push(act('reasoning', block.thinking.trim().slice(0, 160)));
            }
          }
        }
        break;
      }
      case 'result': {
        this.sawResult = true;
        if (typeof obj.result === 'string') this.text = obj.result;
        this.isError = obj.is_error === true || obj.subtype === 'error';
        const u = obj.usage ?? {};
        this.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        if (typeof obj.total_cost_usd === 'number') this.costUsd = obj.total_cost_usd;
        break;
      }
      case 'stream_event':
        // partial deltas; ignored for accumulation (result carries the truth)
        break;
    }
    return out;
  }

  finalize(input: { exitCode: number; stderrTail: string }): FinalCore {
    const ok = !this.isError && (this.sawResult || this.text.length > 0) && input.exitCode === 0;
    return {
      text: this.text.trim(),
      status: ok ? 'ok' : 'error',
      providerSessionId: this.sessionId,
      tokens: this.tokens,
      costUsd: this.costUsd,
      exitCode: input.exitCode,
      rawTail: this.text.slice(-2000),
    };
  }
}

// ---------------------------------------------------------------------------
// Cursor Agent — its `--output-format stream-json` is Claude-compatible NDJSON
// (type system/assistant/result, message.content[].text, session_id, result),
// so we reuse the precise Claude parser. session_id doubles as the resume chatId.
// ---------------------------------------------------------------------------

export class CursorStreamParser extends ClaudeStreamParser {}

// ---------------------------------------------------------------------------
// Generic best-effort JSON/stream parser (codex, gemini)
// ---------------------------------------------------------------------------

export interface GenericJsonConfig {
  sessionIdKeys: string[];
  /** Prefer the last-message file content as the final text. */
  finalFromFile: boolean;
  /** Keys whose string value is assistant text to accumulate. */
  textKeys: string[];
}

export class GenericJsonParser implements StreamParser {
  private text = '';
  private sessionId: string | null = null;
  private tokens = 0;
  private costUsd = 0;
  private rawTail: string[] = [];

  constructor(private cfg: GenericJsonConfig) {}

  onLine(line: string): AgentActivity[] {
    const obj = tryJson(line);
    if (!obj) {
      // Non-JSON lines are usually warnings/logs (e.g. the "YOLO mode" banner),
      // not the agent's result — keep them out of `this.text`. Retain a
      // filtered tail as a last-resort fallback for finalize().
      const t = line.trim();
      if (!t || isNoise(t)) return [];
      this.rawTail.push(t);
      if (this.rawTail.length > 40) this.rawTail.shift();
      return [act('notice', t.slice(0, 160))];
    }

    const out: AgentActivity[] = [];
    const sid = firstString(obj, this.cfg.sessionIdKeys);
    if (sid) this.sessionId = sid;

    // Usage / cost, if present under common shapes.
    const usage = obj.usage ?? obj.stats?.tokens ?? obj.token_usage;
    if (usage && typeof usage === 'object') {
      const t = (usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? usage.total_tokens ?? 0);
      if (t) this.tokens = t;
    }
    if (typeof obj.total_cost_usd === 'number') this.costUsd = obj.total_cost_usd;
    if (typeof obj.cost_usd === 'number') this.costUsd = obj.cost_usd;

    // Tool / command executions across known vendor shapes.
    const toolName =
      firstString(obj, ['tool', 'tool_name']) ??
      (obj.type === 'tool_use' ? obj.name : null) ??
      (obj.item?.type === 'command_execution' ? 'Bash' : null) ??
      (obj.msg?.type === 'exec_command' ? 'Bash' : null);
    if (toolName) {
      const cmd = obj.input?.command ?? obj.command ?? obj.item?.command ?? obj.msg?.command;
      out.push(act('tool', cmd ? `Running ${String(cmd).split('\n')[0]!.slice(0, 80)}` : `Using ${toolName}`, toolName));
    }

    // Assistant text across known shapes.
    let piece =
      firstString(obj, this.cfg.textKeys) ??
      (obj.type === 'assistant' && Array.isArray(obj.message?.content)
        ? obj.message.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('')
        : null) ??
      firstString(obj.msg ?? {}, ['message', 'text']) ??
      firstString(obj.item ?? {}, ['text', 'content']);
    if (piece && typeof piece === 'string') {
      this.text += (this.text ? '\n' : '') + piece;
      const trimmed = piece.trim();
      if (trimmed) out.push(act('text', trimmed.slice(0, 200)));
    }
    return out;
  }

  finalize(input: { exitCode: number; stderrTail: string; lastMessageFileContent?: string }): FinalCore {
    let text = this.text.trim();
    if (this.cfg.finalFromFile && input.lastMessageFileContent && input.lastMessageFileContent.trim()) {
      text = input.lastMessageFileContent.trim();
    }
    if (!text) text = this.rawTail.join('\n').trim().slice(-2000);
    return {
      text,
      status: input.exitCode === 0 ? 'ok' : 'error',
      providerSessionId: this.sessionId,
      tokens: this.tokens,
      costUsd: this.costUsd,
      exitCode: input.exitCode,
      rawTail: this.rawTail.join('\n').slice(-2000),
    };
  }
}

// ---------------------------------------------------------------------------
// Codex — precise `codex exec --json` event parser
// ---------------------------------------------------------------------------

/**
 * Models the codex exec --json event stream. The authoritative final text still
 * comes from the -o last-message file (finalize prefers it); this parser adds
 * rich activities (commands, file changes), the thread id, and token usage.
 */
export class CodexJsonParser implements StreamParser {
  private text = '';
  private sessionId: string | null = null;
  private tokens = 0;
  private costUsd = 0;
  private errored = false;
  private rawTail: string[] = [];

  onLine(line: string): AgentActivity[] {
    const obj = tryJson(line);
    if (!obj) {
      const t = line.trim();
      if (t && !isNoise(t)) {
        this.rawTail.push(t);
        if (this.rawTail.length > 40) this.rawTail.shift();
      }
      return [];
    }
    const out: AgentActivity[] = [];
    switch (obj.type) {
      case 'thread.started':
        this.sessionId = firstString(obj, ['thread_id', 'session_id', 'id']) ?? this.sessionId;
        out.push(act('notice', 'Session ready'));
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = obj.item ?? {};
        const itype = item.type;
        if (itype === 'command_execution') {
          const cmd = String(item.command ?? '').split('\n')[0]!.slice(0, 80);
          if (cmd && obj.type !== 'item.updated') out.push(act('tool', `Running ${cmd}`, 'Bash'));
        } else if (itype === 'file_change') {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          for (const ch of changes) {
            const path = ch?.path ?? ch?.file;
            if (path) out.push(act('tool', `${ch?.kind === 'delete' ? 'Deleting' : 'Editing'} ${path}`, 'Edit'));
          }
        } else if (itype === 'agent_message' && obj.type === 'item.completed') {
          const t = firstString(item, ['text', 'message', 'content']);
          if (t) {
            this.text = t;
            out.push(act('text', t.trim().slice(0, 200)));
          }
        } else if (itype === 'reasoning' && obj.type === 'item.completed') {
          const t = firstString(item, ['text', 'summary']);
          if (t) out.push(act('reasoning', t.trim().slice(0, 160)));
        } else if (itype === 'mcp_tool_call') {
          out.push(act('tool', `Tool ${item.tool ?? item.name ?? 'call'}`, 'mcp'));
        }
        break;
      }
      case 'turn.completed': {
        const u = obj.usage ?? {};
        this.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cached_input_tokens ?? 0);
        break;
      }
      case 'error':
        this.errored = true;
        out.push(act('notice', firstString(obj, ['message', 'error']) ?? 'error'));
        break;
    }
    return out;
  }

  finalize(input: { exitCode: number; stderrTail: string; lastMessageFileContent?: string }): FinalCore {
    let text = this.text.trim();
    if (input.lastMessageFileContent && input.lastMessageFileContent.trim()) {
      text = input.lastMessageFileContent.trim();
    }
    if (!text) text = this.rawTail.join('\n').trim().slice(-2000);
    return {
      text,
      status: input.exitCode === 0 && !this.errored ? 'ok' : 'error',
      providerSessionId: this.sessionId,
      tokens: this.tokens,
      costUsd: this.costUsd,
      exitCode: input.exitCode,
      rawTail: this.rawTail.join('\n').slice(-2000),
    };
  }
}

// ---------------------------------------------------------------------------
// Plain text tail parser (unknown CLIs)
// ---------------------------------------------------------------------------

export class TextTailParser implements StreamParser {
  private lines: string[] = [];

  onLine(line: string): AgentActivity[] {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    const t = line.trim();
    return t ? [act('text', t.slice(0, 200))] : [];
  }

  finalize(input: { exitCode: number; stderrTail: string }): FinalCore {
    const text = this.lines.join('\n').trim();
    return {
      text: text.split('\n').slice(-12).join('\n').slice(0, 4000),
      status: input.exitCode === 0 ? 'ok' : 'error',
      providerSessionId: null,
      tokens: 0,
      costUsd: 0,
      exitCode: input.exitCode,
      rawTail: text.slice(-2000),
    };
  }
}
