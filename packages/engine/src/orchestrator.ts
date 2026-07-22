// The orchestrator: run a Goal to completion via a Dynamic Workflow, with the
// outer Goal-loop (verify → re-drive until success criteria pass / budget /
// stall), resume, and durable event logging.

import {
  Budget,
  Workspace,
  runId as newRunId,
  sessionId as newSessionId,
  type Goal,
  type RunId,
  type SessionId,
  type RunRecord,
  type RunStatus,
  type Store,
  type AnyRunEvent,
  type RunEventType,
  type RunEventPayloadMap,
  type GoalVerdict,
  type PermissionMode,
  resolvePermission,
} from '@omakase/core';
import { RunBus, subscribeRun } from './bus.ts';
import { SubprocessHarness, type Harness } from './harness.ts';
import { WorkflowRuntime } from './runtime.ts';
import { findWorkflow, loadWorkflow, type WorkflowMeta } from './workflows.ts';
import { verifyGoal, type VerifyResult } from './verify.ts';
import { consultAdvisor, advicePreamble } from './advisor.ts';
import { discoverAgents } from './agents.ts';
import { makeSystemPromptFactory } from './prompt.ts';
import { buildResumeState } from './resume.ts';
import { Journal } from './journal.ts';
import { FatalError } from './retry.ts';
import type { Answerer } from './workflow-types.ts';

export const DEFAULT_PROVIDER_PREFERENCE = ['claude', 'codex', 'gemini', 'cursor-agent'];

export interface RunGoalOptions {
  goal: Goal;
  workspace: Workspace;
  store: Store;
  bus?: RunBus;
  harness?: Harness;
  /** Override the workflow name (else goal.workflow or "goal"). */
  workflow?: string;
  sessionId?: string | null;
  signal?: AbortSignal;
  /** Max agent calls (budget). */
  maxAgents?: number;
  /** Max total spend in USD. */
  maxUsd?: number;
  /** Max wall-clock in milliseconds. */
  maxWallClockMs?: number;
  /** Max outer goal-loop rounds. */
  maxRounds?: number;
  /** Max concurrent agent turns. */
  maxConcurrent?: number;
  /** What agents in this run may do (defaults to the workspace setting). */
  permission?: PermissionMode;
  /** Host answerer for w.ask (e.g. CLI stdin, TUI prompt). */
  ask?: Answerer;
  onEvent?: (event: AnyRunEvent) => void;
}

export interface RunOutcome {
  runId: RunId;
  status: RunStatus;
  summary: string | null;
  gaps: string[];
}

/** Start a fresh goal run. */
export async function runGoal(opts: RunGoalOptions): Promise<RunOutcome> {
  const ctx = await prepare(opts, null);
  return execute(ctx, false);
}

/** Resume an existing run by id (replays completed work from the event log). */
export async function resumeRun(
  runIdToResume: RunId,
  opts: Omit<RunGoalOptions, 'goal'> & { goal?: Goal },
): Promise<RunOutcome> {
  const prior = opts.store.getRun(runIdToResume);
  if (!prior) throw new Error(`No such run: ${runIdToResume}`);
  const goal = opts.goal ?? prior.goal;
  const ctx = await prepare({ ...opts, goal }, prior);
  return execute(ctx, true);
}

interface ExecCtx {
  opts: RunGoalOptions;
  run: RunRecord;
  cwd: string;
  bus: RunBus;
  harness: Harness;
  meta: WorkflowMeta;
  availableProviders: string[];
  defaultProvider: string | null;
  providerPreference: string[];
  budget: Budget;
  signal: AbortSignal;
  unsub?: () => void;
  resumeCache?: Map<string, import('./workflow-types.ts').AgentResult>;
  resumeAnswers?: Map<string, string>;
}

/** Reuse the given session (creating it if unknown) or start a fresh one. */
function resolveSession(store: Store, sessionId: SessionId | null, goal: Goal, cwd: string): SessionId {
  const now = Date.now();
  const title = goal.text.slice(0, 60) || 'session';
  if (sessionId) {
    if (!store.getSession(sessionId)) {
      store.createSession({ id: sessionId, title, runIds: [], rollingSummary: '', cwd, createdAt: now, updatedAt: now });
    }
    return sessionId;
  }
  const id = newSessionId();
  store.createSession({ id, title, runIds: [], rollingSummary: '', cwd, createdAt: now, updatedAt: now });
  return id;
}

async function prepare(opts: RunGoalOptions, prior: RunRecord | null): Promise<ExecCtx> {
  const { goal, workspace, store } = opts;
  const cwd = goal.cwd ?? workspace.root;
  const bus = opts.bus ?? new RunBus();
  const harness = opts.harness ?? new SubprocessHarness({ cachePath: workspace.paths.agentsCache });

  const providers = await harness.listProviders();
  const availableProviders = providers.filter((p) => p.available).map((p) => p.id);
  const defaultProvider =
    goal.provider ??
    workspace.settings.defaultProvider ??
    availableProviders.find((id) => DEFAULT_PROVIDER_PREFERENCE.includes(id)) ??
    availableProviders[0] ??
    null;
  const providerPreference = workspace.settings.providerPreference ?? DEFAULT_PROVIDER_PREFERENCE;

  const workflowName = opts.workflow ?? goal.workflow ?? 'goal';
  const meta = findWorkflow(workflowName, { workspace: workspace.paths.workflows });
  if (!meta) throw new Error(`No such workflow: "${workflowName}". Try \`omks workflow list\`.`);

  const maxAgents = opts.maxAgents ?? workspace.settings.maxAgentsPerRun ?? 64;
  const budget = new Budget(maxAgents, {
    ...(opts.maxUsd ? { maxUsd: opts.maxUsd } : {}),
    ...(opts.maxWallClockMs ? { maxWallClockMs: opts.maxWallClockMs } : {}),
  });

  const signal = opts.signal ?? new AbortController().signal;

  let run: RunRecord;
  let resumeCache: Map<string, import('./workflow-types.ts').AgentResult> | undefined;
  let resumeAnswers: Map<string, string> | undefined;
  if (prior) {
    run = prior;
    const state = buildResumeState(store, prior.id);
    resumeCache = state.cache;
    resumeAnswers = state.answers;
    budget.seed(state.spentAgents, state.tokens, state.costUsd);
    store.updateRun(prior.id, { status: 'running', error: null });
  } else {
    const now = Date.now();
    run = {
      id: newRunId(),
      sessionId: resolveSession(store, opts.sessionId ?? null, goal, cwd),
      mode: 'goal',
      workflow: meta.name,
      status: 'running',
      goal,
      title: goal.text.slice(0, 80),
      summary: null,
      spentAgents: 0,
      budgetAgents: maxAgents,
      spentTokens: 0,
      spentCostUsd: 0,
      lastSeq: 0,
      checkpointSeq: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      rateLimitedUntil: null,
    };
    store.createRun(run);
  }

  const ctx: ExecCtx = {
    opts,
    run,
    cwd,
    bus,
    harness,
    meta,
    availableProviders,
    defaultProvider,
    providerPreference,
    budget,
    signal,
    ...(resumeCache ? { resumeCache } : {}),
    ...(resumeAnswers ? { resumeAnswers } : {}),
  };
  if (opts.onEvent) {
    ctx.unsub = subscribeRun(store, bus, run.id, prior ? prior.lastSeq : 0, opts.onEvent);
  }
  return ctx;
}

async function execute(ctx: ExecCtx, resuming: boolean): Promise<RunOutcome> {
  const { opts, run } = ctx;
  const { store, goal, workspace } = opts;
  const emit = <T extends RunEventType>(type: T, payload: RunEventPayloadMap[T]) => {
    const e = store.appendEvent(run.id, type, payload);
    ctx.bus.emit(e as AnyRunEvent);
  };

  // Mirror this run's events to a portable JSONL journal.
  const journal = new Journal(workspace.paths.runs);
  const unsubJournal = ctx.bus.on(run.id, (e) => journal.append(e));

  const loaded = await loadWorkflow(ctx.meta);
  const judgeProvider = ctx.defaultProvider ?? ctx.availableProviders[0] ?? null;

  // Verifying costs real time and money — a `command` criterion shells out to
  // the user's test suite, a `judge` one spends a model call. Only an agent can
  // change the workspace, so a verdict can only go stale once one finishes:
  // memoise it per agent-epoch. This is what collapses a workflow's closing
  // `w.goalMet()` and the orchestrator's verify() below into a single check
  // instead of running the suite twice back to back.
  let epoch = 0;
  const unsubEpoch = ctx.bus.on(run.id, (e) => {
    if (e.type === 'agent:completed' || e.type === 'agent:failed') epoch++;
  });
  let memo: { epoch: number; result: Promise<VerifyResult> } | null = null;
  const verify = (): Promise<VerifyResult> => {
    if (memo && memo.epoch === epoch) return memo.result;
    const result = verifyGoal({
      goal,
      cwd: ctx.cwd,
      harness: ctx.harness,
      judgeProvider,
      signal: ctx.signal,
      log: (m) => emit('log', { level: 'info', message: m }),
      // A judge criterion spends real money the run never charged an agent for.
      // Record it against both the run's reported cost and the budget, so
      // `--max-usd` accounts for verification instead of overshooting silently.
      onSpend: (tokens, costUsd) => {
        ctx.budget.addUsage(tokens, costUsd);
        store.addSpend(run.id, { tokens, costUsd });
      },
    });
    memo = { epoch, result };
    // Never cache a failure: a criterion that threw (an aborted command, a judge
    // that timed out) must be retried, not replayed for the rest of the run.
    result.catch(() => {
      if (memo?.result === result) memo = null;
    });
    return result;
  };

  const runtime = new WorkflowRuntime({
    runId: run.id,
    goal,
    cwd: ctx.cwd,
    store,
    bus: ctx.bus,
    harness: ctx.harness,
    budget: ctx.budget,
    signal: ctx.signal,
    // One object, shared with the goal: the round loop below feeds each pass its
    // gaps by mutating goal.params, which w.params must alias rather than copy.
    params: (goal.params ??= {}),
    permission: opts.permission ?? resolvePermission(workspace.settings),
    agentDefinitions: discoverAgents(workspace.paths.agents),
    defaultProvider: ctx.defaultProvider,
    ...(goal.provider ? { pinnedProvider: goal.provider } : {}),
    ...(goal.model ? { pinnedModel: goal.model } : {}),
    ...(workspace.settings.defaultModel ? { defaultModel: workspace.settings.defaultModel } : {}),
    providerPreference: ctx.providerPreference,
    availableProviders: ctx.availableProviders,
    systemPromptFor: makeSystemPromptFactory({ goal, memory: workspace.readMemory() }),
    verify,
    ...(ctx.resumeCache ? { resumeCache: ctx.resumeCache } : {}),
    ...(ctx.resumeAnswers ? { resumeAnswers: ctx.resumeAnswers } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
  });

  if (resuming) emit('run:resumed', { fromSeq: run.lastSeq });
  else emit('run:started', { goal, workflow: ctx.meta.name });

  const hasCriteria = (goal.checks?.length ?? 0) + (goal.successCriteria?.length ?? 0) > 0;
  const maxRounds = opts.maxRounds ?? (hasCriteria ? 3 : 1);

  let status: RunStatus = 'running';
  let gaps: string[] = [];
  let prevSignature = '';
  let budgetStop: string | null = null;
  let advised = false; // one consult per run

  try {
    for (let round = 0; round < maxRounds; round++) {
      if (ctx.signal.aborted) {
        status = 'cancelled';
        break;
      }
      if (round > 0) {
        // Feed the gaps to the next pass via params.
        goal.params!.gaps = gaps;
        goal.params!.round = round;
      }

      await loaded.fn(runtime);

      // A workflow finishes "normally" even when its agents were aborted, so a
      // cancel must be caught here — otherwise a run with no success criteria
      // falls into the "trust the workflow" branch below and reports success.
      if (ctx.signal.aborted) {
        status = 'cancelled';
        break;
      }

      const verdict = await verify();
      gaps = verdict.gaps;
      const v: GoalVerdict = verdict.met ? 'met' : gaps.length ? 'unmet' : 'unknown';
      emit('goal:evaluated', {
        round,
        verdict: v,
        gaps,
        note: verdict.results.map((r) => `${r.met ? '✓' : '✗'} ${r.label}`).join('; '),
      });

      if (hasCriteria && verdict.met) {
        status = 'succeeded';
        break;
      }
      // Agents the budget turned away returned an error the workflow was free to
      // swallow, so its completion is no oracle — it can finish and file a rosy
      // report having built nothing. Only a refused call counts: a run that lands
      // exactly on its cap spent every slot on real work.
      const denied = ctx.budget.deniedReason();
      if (denied) {
        budgetStop = denied;
        status = 'failed';
        break;
      }
      if (!hasCriteria) {
        // No oracle → trust the workflow's own completion.
        status = 'succeeded';
        break;
      }
      if (!ctx.budget.canSpend()) {
        status = 'failed';
        break;
      }
      // Stall detection: identical unmet signature two rounds running.
      const signature = gaps.slice().sort().join('|');
      if (signature && signature === prevSignature) {
        // Circling the same gaps means the fix agents are repeating an approach
        // that does not work. The run knows how it got here — hand that log to
        // one advisor and spend a final round on what it suggests, rather than
        // stopping with the evidence unread. Once only: if the round after the
        // advice stalls again, the advice did not help and stopping is right.
        const canAdvise = !advised && judgeProvider && round + 1 < maxRounds && ctx.budget.canSpend();
        if (canAdvise) {
          advised = true;
          emit('log', { level: 'info', message: 'No progress — consulting an advisor.' });
          const advice = await consultAdvisor(
            { goalText: goal.text, gaps, round, events: store.getEvents(run.id) },
            {
              harness: ctx.harness,
              provider: judgeProvider,
              cwd: ctx.cwd,
              signal: ctx.signal,
              onSpend: (tokens, costUsd) => {
                ctx.budget.addUsage(tokens, costUsd);
                store.addSpend(run.id, { tokens, costUsd });
              },
            },
          );
          if (advice) {
            goal.params!.advice = advicePreamble(advice);
            emit('log', { level: 'info', message: `Advice: ${advice.headline}` });
            // Exactly one round to act on it: the signature is left in place, so
            // if that round closes on the same gaps the stall check ends the run.
            continue;
          }
          emit('log', { level: 'warn', message: 'No advice available.' });
        }
        status = 'failed';
        emit('log', { level: 'warn', message: 'No progress detected — stopping (stalled).' });
        break;
      }
      prevSignature = signature;
      if (round === maxRounds - 1) status = 'failed';
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    status = ctx.signal.aborted ? 'cancelled' : 'failed';
    budgetStop ??= ctx.budget.deniedReason();
    store.updateRun(run.id, { error: msg });
    emit('log', { level: 'error', message: `Workflow error: ${msg}` });
    if (err instanceof FatalError) emit('log', { level: 'error', message: 'Fatal — not retrying.' });
  }

  // A workflow may have filed a rosy final report before it was cut short, so a
  // run stopped by a cancel or an exhausted budget always reports that rather
  // than the workflow's summary.
  const finalReport = store.listReports(run.id).filter((r) => r.kind === 'final').at(-1);
  const summary =
    status === 'cancelled'
      ? 'Run cancelled.'
      : budgetStop
        ? `Budget exhausted: ${budgetStop}.`
        : (finalReport?.summary ??
          (status === 'succeeded'
            ? 'Goal achieved.'
            : gaps.length
              ? `Incomplete. Remaining: ${gaps.slice(0, 3).join('; ')}`
              : 'Run ended without meeting the goal.'));

  store.updateRun(run.id, { status, summary });

  // Attach this run to its session and extend the rolling summary.
  if (run.sessionId) {
    const s = store.getSession(run.sessionId);
    if (s) {
      const runIds = s.runIds.includes(run.id) ? s.runIds : [...s.runIds, run.id];
      const rolling = `${s.rollingSummary ? s.rollingSummary + '\n' : ''}• ${status}: ${summary}`.slice(-2000);
      store.updateSession(run.sessionId, { runIds, rollingSummary: rolling });
    }
  }

  emit('run:ended', { status, summary });
  unsubEpoch();
  unsubJournal();
  ctx.unsub?.();
  return { runId: run.id, status, summary, gaps };
}
