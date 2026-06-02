/**
 * The pi RPC executor drives `pi --mode rpc`: spawn pi, send the `prompt`
 * command on stdin, auto-resolve extension-UI dialogs, map streamed events to
 * {@link AgentEvent}s, and finish on `agent_end` (pi stays alive for further
 * prompts, so we close stdin and terminate it).
 */
import { createJsonLineStream } from '../../protocol/json-lines.js';
import {
  buildExtensionUiResponse,
  buildPiPromptCommand,
  isExtensionUiRequest,
  mapPiRpcEvent,
  type PiMapperState,
} from '../../protocol/pi-rpc.js';
import type { AgentEndReason, AgentEvent } from '../../protocol/events.js';
import type { RuntimeContext } from '../../runtimes/types.js';
import { AgentNotInstalledError, AgentProtocolError, AgentTimeoutError } from '../errors.js';
import type { AgentExecutor, ExecutorContext } from '../executor.js';
import { streamFromDriver } from '../stream.js';

async function piRpcDriver(
  push: (event: AgentEvent) => void,
  ctx: ExecutorContext,
): Promise<AgentEndReason> {
  const { def, input, transport, resolvedBin } = ctx;
  if (!def) throw new AgentProtocolError('pi executor requires a runtime def');
  if (!resolvedBin) throw new AgentNotInstalledError(input.agentId);

  const runtimeContext: RuntimeContext = {
    cwd: input.cwd,
    hasPriorAssistantTurn: input.hasPriorAssistantTurn,
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

  const state: PiMapperState = {
    startedAt: ctx.now(),
    sentFirstToken: false,
    now: ctx.now,
  };
  push({ type: 'status', label: 'initializing', model: input.model ?? null });

  let nextRpcId = 1;
  const promptId = nextRpcId++;
  let ended = false;

  proc.writeStdin(buildPiPromptCommand(promptId, input.prompt));

  const parser = createJsonLineStream((raw) => {
    if (ended) return;
    if (isExtensionUiRequest(raw)) {
      const reply = buildExtensionUiResponse(raw);
      if (reply) proc.writeStdin(reply);
      return;
    }
    const obj = raw as { type?: unknown; id?: unknown; success?: unknown; error?: unknown };
    if (obj.type === 'response') {
      if (obj.id === promptId && obj.success === false) {
        push({ type: 'error', message: `prompt rejected: ${String(obj.error ?? 'unknown')}` });
      }
      return;
    }
    const { events, ended: isEnd } = mapPiRpcEvent(raw, state);
    for (const event of events) push(event);
    if (isEnd) {
      ended = true;
      proc.endStdin();
    }
  });

  try {
    for await (const chunk of proc.stdout) {
      parser.feed(chunk);
      if (ended) break;
    }
    parser.flush();
    if (ended) proc.kill('SIGTERM');

    const exit = await proc.wait();
    if (timedOut) throw new AgentTimeoutError(input.timeoutMs!);
    if (ac.signal.aborted && !ended) return 'cancelled';
    if (!ended && exit.code !== 0 && exit.code !== null) {
      push({ type: 'error', message: `Pi exited with code ${exit.code}` });
      return 'error';
    }
    return 'completed';
  } finally {
    if (timer) clearTimeout(timer);
    if (input.signal) input.signal.removeEventListener('abort', onUserAbort);
  }
}

export const piRpcExecutor: AgentExecutor = (ctx) => streamFromDriver(ctx, piRpcDriver);
