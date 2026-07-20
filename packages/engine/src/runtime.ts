// WorkflowRuntime — the concrete `w` handed to a Dynamic Workflow.
//
// It turns w.agent()/phase()/parallel()/pipeline()/loopUntil() into harness
// calls, event-log writes, budget accounting, bounded concurrency, foundation
// retry, and (on resume) cached replay.
//
// Determinism for resume: every agent() call gets a STRUCTURAL step key derived
// from an AsyncLocalStorage path (phase/parallel-index/pipeline-item-stage/loop-
// round) + a per-path counter. The key is stored in the event, so replay matches
// cached results by structure — robust to non-deterministic completion order.

import { AsyncLocalStorage } from 'node:async_hooks';
import { join, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  agentCallId,
  reportId,
  slugify,
  uuid,
  isAbortError,
  type Budget,
  type Goal,
  type RunId,
  type Store,
  type RunEventType,
  type RunEventPayloadMap,
  type AnyRunEvent,
  type BudgetSnapshot,
  type PermissionMode,
} from '@omakase/core';
import type { RunBus } from './bus.ts';
import type { Harness } from './harness.ts';
import { withRetry, FatalError } from './retry.ts';
import { isRateLimit } from '@omakase/providers';
import { Semaphore } from './semaphore.ts';
import { isGitRepo, createWorktree, commitAndMerge, removeWorktree, GitSerializer } from './isolate.ts';
import { applyAgentDefinition, type AgentDefinition } from './agents.ts';
import type {
  WorkflowContext,
  AgentSpec,
  AgentResult,
  AskRequest,
  Answerer,
  ReportSpec,
  WikiSpec,
  PipelineStage,
} from './workflow-types.ts';

export interface RuntimeDeps {
  runId: RunId;
  goal: Goal;
  cwd: string;
  store: Store;
  bus: RunBus;
  harness: Harness;
  budget: Budget;
  signal: AbortSignal;
  params: Record<string, unknown>;
  permission: PermissionMode;
  /** Named agent definitions discovered in the workspace. */
  agentDefinitions?: AgentDefinition[];
  defaultProvider: string | null;
  providerPreference: string[];
  availableProviders: string[];
  systemPromptFor: (spec: AgentSpec) => string | undefined;
  /** Success-criteria evaluator (goal-loop verifier). */
  verify: () => Promise<{ met: boolean; gaps: string[] }>;
  /** Cached agent results by stepKey (resume). */
  resumeCache?: Map<string, AgentResult>;
  /** Cached user answers by stepKey (resume). */
  resumeAnswers?: Map<string, string>;
  /** Host answerer for w.ask (CLI stdin, TUI prompt); absent → auto-default. */
  ask?: Answerer;
  /** Max concurrent agent turns. */
  maxConcurrent?: number;
  /** Retry attempts per agent call. */
  maxAttempts?: number;
}

export class WorkflowRuntime implements WorkflowContext {
  readonly goal: Goal;
  readonly cwd: string;
  readonly params: Record<string, unknown>;
  readonly providers: string[];
  readonly agentNames: string[];
  readonly signal: AbortSignal;

  private readonly d: RuntimeDeps;
  private readonly pathStore = new AsyncLocalStorage<string>();
  private readonly pathCounters = new Map<string, number>();
  private readonly sem: Semaphore;
  private readonly resumeCache: Map<string, AgentResult>;
  private readonly resumeAnswers: Map<string, string>;

  constructor(deps: RuntimeDeps) {
    this.d = deps;
    this.goal = deps.goal;
    this.cwd = deps.cwd;
    this.params = deps.params;
    this.providers = deps.availableProviders;
    this.agentNames = (deps.agentDefinitions ?? []).map((d) => d.name);
    this.signal = deps.signal;
    this.sem = new Semaphore(deps.maxConcurrent ?? 6);
    this.resumeCache = deps.resumeCache ?? new Map();
    this.resumeAnswers = deps.resumeAnswers ?? new Map();
  }

  private emit<T extends RunEventType>(type: T, payload: RunEventPayloadMap[T]): void {
    const e = this.d.store.appendEvent(this.d.runId, type, payload);
    this.d.bus.emit(e as AnyRunEvent);
  }

  private currentPath(): string {
    return this.pathStore.getStore() ?? 'root';
  }

  private allocStepKey(): string {
    const p = this.currentPath();
    const n = this.pathCounters.get(p) ?? 0;
    this.pathCounters.set(p, n + 1);
    return `${p}#${n}`;
  }

  private runInSegment<T>(segment: string, fn: () => T | Promise<T>): Promise<T> {
    const next = `${this.currentPath()}/${segment}`;
    return Promise.resolve(this.pathStore.run(next, fn));
  }

  // --- provider selection -------------------------------------------------

  private selectProvider(explicit?: string): string | null {
    const avail = this.d.availableProviders;
    if (explicit && avail.includes(explicit)) return explicit;
    if (this.d.defaultProvider && avail.includes(this.d.defaultProvider)) return this.d.defaultProvider;
    for (const p of this.d.providerPreference) if (avail.includes(p)) return p;
    // Last resort: detection may return nothing (CI, a cache miss, or a forced
    // command) — still try the explicit/default so the run attempts it rather
    // than giving up. A genuinely-missing binary then fails with a clear error.
    return explicit ?? this.d.defaultProvider ?? avail[0] ?? this.d.providerPreference[0] ?? null;
  }

  // --- agent --------------------------------------------------------------

  async agent(rawSpec: AgentSpec): Promise<AgentResult> {
    const stepKey = this.allocStepKey();

    // Resume: return cached result without re-running or re-charging. Done
    // before resolving a definition, so editing `.omks/agents/` between a run
    // and its resume cannot shift which cached result answers this call.
    const cached = this.resumeCache.get(stepKey);
    if (cached) {
      this.log(`↺ cached: ${rawSpec.title}`);
      return cached;
    }

    const spec = this.resolveSpec(rawSpec);

    // A step that asked for its own working copy gets one, and the rest of this
    // call runs against it — which is what lets parallel writers stop colliding.
    if (spec.isolate && !spec.cwd) {
      return await this.isolate(slugify(spec.title) || 'agent', (isolatedCwd) =>
        this.dispatchAgent({ ...spec, isolate: false, cwd: isolatedCwd }, stepKey),
      );
    }
    return this.dispatchAgent(spec, stepKey);
  }

  /** Fold in a named definition from `.omks/agents/`, if the call asked for one. */
  private resolveSpec(spec: AgentSpec): AgentSpec {
    if (!spec.as) return spec;
    const def = this.d.agentDefinitions?.find((d) => d.name === spec.as);
    if (!def) {
      this.log(`no agent definition named "${spec.as}" — using the call as written`);
      return spec;
    }
    return applyAgentDefinition(spec, def);
  }

  private async dispatchAgent(spec: AgentSpec, stepKey: string): Promise<AgentResult> {
    const candidates = this.providerCandidates(spec.provider);
    const callId = agentCallId();
    const role = spec.role ?? 'worker';

    if (candidates.length === 0) {
      this.emit('agent:failed', { callId, stepKey, error: 'no provider available', attempt: 1 });
      return this.errorResult('No agent provider available. Run `omks agent scan`.');
    }
    if (this.signal.aborted) {
      this.emit('agent:failed', { callId, stepKey, error: 'aborted', attempt: 1 });
      return this.errorResult('Cancelled');
    }
    if (!this.d.budget.chargeAgent()) {
      const reason = this.d.budget.stopReason() ?? 'budget exhausted';
      this.emit('agent:failed', { callId, stepKey, error: `budget: ${reason}`, attempt: 1 });
      return this.errorResult(`Budget: ${reason}.`);
    }

    this.emit('agent:started', {
      callId,
      stepKey,
      role,
      title: spec.title,
      provider: candidates[0]!,
      model: spec.model ?? null,
      prompt: spec.prompt,
      attempt: 1,
    });

    const base = spec.systemPrompt ?? this.d.systemPromptFor(spec);
    const systemPrompt = spec.guidance && base ? `${base}\n\n${spec.guidance}` : (base ?? spec.guidance);
    const agentCwd = this.resolveAgentCwd(spec.cwd);
    let lastError = 'agent failed';
    let aborted = false;

    // Try each candidate provider in turn; on failure, fall back to the next.
    for (let pi = 0; pi < candidates.length; pi++) {
      const provider = candidates[pi]!;
      if (this.signal.aborted) {
        aborted = true;
        break;
      }
      if (pi > 0) this.emit('harness:switched', { from: candidates[pi - 1]!, to: provider, reason: lastError.slice(0, 80) });

      try {
        // Each attempt gets its OWN pre-minted session id: a provider like Claude
        // registers --session-id on a failed attempt, so reusing it would fail
        // the retry with "session already in use".
        let lastPlanned = uuid();
        const res = await withRetry(
          async () => {
            const planned = uuid();
            lastPlanned = planned;
            const r = await this.sem.run(() =>
              this.d.harness.runAgent({
                provider,
                ...(spec.model ? { model: spec.model } : {}),
                role,
                title: spec.title,
                prompt: spec.prompt,
                ...(systemPrompt ? { systemPrompt } : {}),
                cwd: agentCwd,
                permission: spec.permission ?? this.d.permission,
                plannedSessionId: planned,
                ...(spec.resumeSessionId ? { resumeSessionId: spec.resumeSessionId } : {}),
                onActivity: (a) => this.emit('agent:activity', { callId, activity: a }),
                signal: this.signal,
              }),
            );
            if (r.status === 'error') throw new Error(r.text || 'agent returned an error');
            return r;
          },
          {
            maxAttempts: this.d.maxAttempts ?? 3,
            signal: this.signal,
            isRateLimited: (err) => isRateLimit(err instanceof Error ? err.message : String(err)),
            onRetry: ({ attempt, delayMs, rateLimited }) => {
              if (rateLimited) this.d.store.updateRun(this.d.runId, { rateLimitedUntil: Date.now() + delayMs });
              this.emit('agent:retry', { callId, stepKey, attempt, delayMs, reason: rateLimited ? 'rate-limited' : 'backoff' });
            },
          },
        );

        const out: AgentResult = {
          text: res.text,
          status: 'ok',
          sessionId: res.sessionId ?? lastPlanned,
          provider: res.provider,
          tokens: res.tokens,
          costUsd: res.costUsd,
        };
        this.d.budget.addUsage(res.tokens, res.costUsd);
        this.d.store.addSpend(this.d.runId, { agents: 1, tokens: res.tokens, costUsd: res.costUsd });
        this.emit('agent:completed', {
          callId,
          stepKey,
          text: res.text,
          status: 'ok',
          providerSessionId: out.sessionId,
          tokens: res.tokens,
          costUsd: res.costUsd,
          durationMs: res.durationMs,
        });
        return out;
      } catch (err) {
        if (isAbortError(err)) {
          aborted = true;
          break;
        }
        lastError = err instanceof Error ? err.message : String(err);
        // fall through to the next candidate provider
      }
    }

    // A cancel is not a failure, and reporting one as `agent failed` makes a
    // whole cancelled run read like it broke. The pre-flight check above already
    // says 'aborted'; an agent cut short mid-turn says the same.
    if (aborted) lastError = 'aborted';
    this.d.store.addSpend(this.d.runId, { agents: 1 });
    this.emit('agent:failed', { callId, stepKey, error: lastError, attempt: this.d.maxAttempts ?? 3 });
    return this.errorResult(aborted ? 'Cancelled' : lastError, candidates[0]!);
  }

  /** Ordered provider candidates: the selected one, then fallbacks (bounded). */
  private providerCandidates(explicit?: string): string[] {
    const avail = this.d.availableProviders;
    const first = this.selectProvider(explicit);
    if (!first) return [];
    const seen = new Set<string>([first]);
    const rest: string[] = [];
    for (const p of [explicit, this.d.defaultProvider, ...this.d.providerPreference, ...avail]) {
      if (p && avail.includes(p) && !seen.has(p)) {
        seen.add(p);
        rest.push(p);
      }
    }
    return [first, ...rest].slice(0, 3);
  }

  spawn(provider: string, prompt: string, title = 'agent'): Promise<AgentResult> {
    return this.agent({ provider, prompt, title, role: 'worker' });
  }

  subdir(name: string): string {
    const dir = isAbsolute(name) ? name : join(this.cwd, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private readonly git = new GitSerializer();

  async isolate<T>(label: string, fn: (cwd: string) => Promise<T> | T): Promise<T> {
    const base = this.cwd;
    if (!isGitRepo(base)) return await fn(base);
    const wt = await this.git.run(() => createWorktree(base, label));
    try {
      const result = await fn(wt.path);
      const res = await this.git.run(() => commitAndMerge(base, wt, label));
      const merged = res.merged;
      if (!merged) this.log(`isolate(${label}): merge conflict — changes kept on branch ${wt.branch}`);
      await this.git.run(() => removeWorktree(base, wt, merged));
      return result;
    } catch (err) {
      // Only the success path above commits, so nothing here is on the branch
      // yet, and removeWorktree's `git worktree remove --force` would discard
      // every edit the callback had already made. Leave it on disk instead.
      this.log(`isolate(${label}): failed — work left in ${wt.path} (branch ${wt.branch})`);
      throw err;
    }
  }

  private resolveAgentCwd(specCwd?: string): string {
    if (!specCwd) return this.cwd;
    const dir = isAbsolute(specCwd) ? specCwd : join(this.cwd, specCwd);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private errorResult(text: string, provider = 'none'): AgentResult {
    return { text, status: 'error', sessionId: null, provider, tokens: 0, costUsd: 0 };
  }

  // --- structure ----------------------------------------------------------

  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const index = this.pathCounters.get(`phase-index`) ?? 0;
    this.pathCounters.set('phase-index', index + 1);
    this.emit('phase:started', { name, index });
    try {
      return await this.runInSegment(`ph:${name}`, fn);
    } finally {
      this.emit('phase:ended', { name, index });
    }
  }

  async parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
    return Promise.all(thunks.map((t, i) => this.runInSegment(`par:${i}`, t)));
  }

  async pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, i) => {
        let prev: unknown = item;
        for (let s = 0; s < stages.length; s++) {
          const stage = stages[s]!;
          try {
            prev = await this.runInSegment(`pipe:${i}:${s}`, () => stage(prev, item, i));
          } catch (err) {
            this.log(`pipeline item ${i} stage ${s} failed: ${(err as Error).message}`);
            return null;
          }
        }
        return prev;
      }),
    );
  }

  async loopUntil(
    fn: (round: number) => Promise<unknown[] | void> | unknown[] | void,
    opts: { maxRounds?: number } = {},
  ): Promise<void> {
    const maxRounds = opts.maxRounds ?? 5;
    for (let round = 0; round < maxRounds; round++) {
      if (this.signal.aborted) return;
      const remaining = await this.runInSegment(`loop:${round}`, () => fn(round));
      if (!remaining || (Array.isArray(remaining) && remaining.length === 0)) return;
    }
  }

  // --- reporting / state --------------------------------------------------

  budget(): BudgetSnapshot {
    return this.d.budget.snapshot();
  }

  log(message: string): void {
    this.emit('log', { level: 'info', message });
  }

  requestReport(spec: ReportSpec): void {
    const report = {
      runId: this.d.runId,
      id: reportId(),
      kind: spec.kind ?? ('progress' as const),
      title: spec.title,
      summary: spec.summary,
      taskId: spec.taskId ?? null,
      authorAgentId: null,
      createdAt: Date.now(),
    };
    this.d.store.addReport(report);
    this.emit('report', { report });
    if (spec.kind === 'final') {
      this.d.store.updateRun(this.d.runId, { summary: spec.summary });
    }
  }

  updateWiki(spec: WikiSpec): void {
    const slug = spec.slug ?? slugify(spec.title);
    this.d.store.upsertWiki({ slug, title: spec.title, body: spec.body, updatedAt: Date.now() });
    this.emit('wiki:updated', { slug, title: spec.title });
  }

  recall(limit = 5): { title: string; body: string }[] {
    return this.d.store
      .listWiki()
      .slice(0, Math.max(0, limit))
      .map((e) => ({ title: e.title, body: e.body }));
  }

  async goalMet(): Promise<{ met: boolean; gaps: string[] }> {
    const res = await this.d.verify();
    return res;
  }

  async ask(question: string, opts: { options?: string[]; default?: string } = {}): Promise<string> {
    const stepKey = this.allocStepKey();
    const cached = this.resumeAnswers.get(stepKey);
    if (cached !== undefined) return cached;

    this.emit('user:asked', { stepKey, question, options: opts.options ?? [] });
    let answer: string;
    if (this.d.ask) {
      const answerOpts: AskRequest = { question };
      if (opts.options) answerOpts.options = opts.options;
      if (opts.default !== undefined) answerOpts.default = opts.default;
      answer = await this.d.ask(answerOpts);
    } else {
      answer = opts.default ?? opts.options?.[0] ?? '';
      this.log(`(no answerer — defaulting "${question.slice(0, 40)}" → "${answer}")`);
    }
    this.emit('user:answered', { stepKey, answer });
    return answer;
  }
}

export { FatalError };
