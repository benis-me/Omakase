/**
 * The spawn executor drives any external agent CLI: build argv from the def,
 * spawn through the transport, deliver the prompt on stdin (text or
 * stream-json), parse stdout via the format mapper, and translate exit/abort
 * into terminal events.
 */
import { createJsonLineStream } from '../../protocol/json-lines.js';
import type { AgentEndReason, AgentEvent } from '../../protocol/events.js';
import type { RuntimeContext } from '../../runtimes/types.js';
import {
  AgentNotInstalledError,
  AgentProtocolError,
  AgentTimeoutError,
  isAgentRuntimeError,
} from '../errors.js';
import { getJsonMapper, type JsonMapperState } from '../parsers.js';
import type { AgentExecutor, ExecutorContext } from '../executor.js';
import { streamFromDriver } from '../stream.js';

function anthropicUserMessageLine(prompt: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  })}\n`;
}

async function spawnDriver(
  push: (event: AgentEvent) => void,
  ctx: ExecutorContext,
): Promise<AgentEndReason> {
  const { def, input, transport, resolvedBin } = ctx;
  if (!def) throw new AgentProtocolError('spawn executor requires a runtime def');
  if (!resolvedBin) throw new AgentNotInstalledError(input.agentId);

  const runtimeContext: RuntimeContext = {
    cwd: input.cwd,
    hasPriorAssistantTurn: input.hasPriorAssistantTurn,
    capabilities: ctx.capabilities ?? ctx.detected?.capabilities,
  };
  const args = def.buildArgs(
    input.prompt,
    input.imagePaths ?? [],
    input.extraAllowedDirs ?? [],
    { model: input.model, reasoning: input.reasoning },
    runtimeContext,
  );

  const ac = new AbortController();
  let timedOut = false;
  const onUserAbort = (): void => ac.abort();
  if (input.signal) {
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener('abort', onUserAbort, { once: true });
  }
  const timer =
    input.timeoutMs && input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, input.timeoutMs)
      : undefined;

  const env = { ...(input.env ?? process.env), ...(def.env ?? {}) };
  const proc = transport.spawn({
    command: resolvedBin,
    args,
    cwd: input.cwd,
    env,
    signal: ac.signal,
  });

  // Deliver the prompt.
  if (def.promptViaStdin) {
    proc.writeStdin(
      def.promptInputFormat === 'stream-json'
        ? anthropicUserMessageLine(input.prompt)
        : input.prompt,
    );
  }
  proc.endStdin();

  // Drain stderr so we can attach it to a non-zero exit message.
  let stderrText = '';
  const stderrDone = (async () => {
    for await (const chunk of proc.stderr) stderrText += chunk;
  })().catch(() => undefined);

  const startedAt = ctx.now();
  push({ type: 'status', label: 'initializing', model: input.model ?? null });

  try {
    const mapper = getJsonMapper(def.streamFormat);
    if (mapper) {
      const state: JsonMapperState = {
        startedAt,
        sentFirstToken: false,
        streamedText: false,
        now: ctx.now,
      };
      const parser = createJsonLineStream((raw) => {
        for (const event of mapper(raw, state)) push(event);
      });
      for await (const chunk of proc.stdout) parser.feed(chunk);
      parser.flush();
    } else {
      // plain-text: stream stdout straight through as text deltas.
      let first = true;
      for await (const chunk of proc.stdout) {
        if (first) {
          first = false;
          push({ type: 'status', label: 'streaming', ttftMs: ctx.now() - startedAt });
        }
        push({ type: 'text_delta', delta: chunk });
      }
    }

    const exit = await proc.wait();
    await stderrDone;

    if (timedOut) throw new AgentTimeoutError(input.timeoutMs!);
    if (ac.signal.aborted) return 'cancelled';
    if (exit.code !== 0 && exit.code !== null) {
      const detail = stderrText.trim().slice(0, 500);
      push({
        type: 'error',
        message: `${def.name} exited with code ${exit.code}${detail ? `: ${detail}` : ''}`,
      });
      return 'error';
    }
    return 'completed';
  } catch (err) {
    // Any abnormal exit from the read loop (e.g. a non-EPIPE stdin error that
    // failed the stdout stream) must not orphan the child. Killing an already
    // exited process is a no-op.
    proc.kill('SIGTERM');
    if (err instanceof AgentTimeoutError) throw err;
    if (isAgentRuntimeError(err) && err.code === 'spawn_failed') {
      const errno = err.detail?.errno;
      if (errno === 'ENOENT') {
        throw new AgentNotInstalledError(input.agentId, undefined, { cause: err });
      }
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener('abort', onUserAbort);
  }
}

export const spawnExecutor: AgentExecutor = (ctx) => streamFromDriver(ctx, spawnDriver);
