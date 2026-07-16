// The goal-loop verifier: evaluate a goal's success criteria. This is the
// loop's terminating oracle and a core quality lever — it keeps an autonomous
// run honest instead of letting it self-declare victory.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Goal, SuccessCriterion } from '@omakase/core';
import type { Harness } from './harness.ts';

export interface VerifyContext {
  goal: Goal;
  cwd: string;
  harness: Harness;
  /** Provider used for judge criteria. */
  judgeProvider: string | null;
  judgeModel?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface CriterionResult {
  label: string;
  met: boolean;
  detail: string;
}

export interface VerifyResult {
  met: boolean;
  gaps: string[];
  results: CriterionResult[];
}

export async function verifyGoal(ctx: VerifyContext): Promise<VerifyResult> {
  const checks = ctx.goal.checks ?? [];
  const nlCriteria = ctx.goal.successCriteria ?? [];

  const results: CriterionResult[] = [];
  for (const c of checks) {
    results.push(await evalCriterion(c, ctx));
  }

  // Judge natural-language criteria as one rubric, if any and not already judged.
  if (nlCriteria.length) {
    results.push(
      await evalCriterion(
        { kind: 'judge', rubric: nlCriteria.map((c) => `- ${c}`).join('\n'), label: 'success criteria' },
        ctx,
      ),
    );
  }

  // No criteria at all → nothing to verify; treat as met (workflow-driven).
  if (results.length === 0) return { met: true, gaps: [], results: [] };

  const gaps = results.filter((r) => !r.met).map((r) => `${r.label}: ${r.detail}`);
  return { met: gaps.length === 0, gaps, results };
}

async function evalCriterion(c: SuccessCriterion, ctx: VerifyContext): Promise<CriterionResult> {
  switch (c.kind) {
    case 'command':
      return evalCommand(c, ctx);
    case 'file':
      return evalFile(c, ctx);
    case 'rule':
      return evalRule(c, ctx);
    case 'judge':
      return evalJudge(c, ctx);
  }
}

async function evalCommand(
  c: Extract<SuccessCriterion, { kind: 'command' }>,
  ctx: VerifyContext,
): Promise<CriterionResult> {
  const label = c.label ?? `\`${c.run}\``;
  ctx.log?.(`verify: running ${c.run}`);
  try {
    const proc = Bun.spawn(['sh', '-c', c.run], {
      cwd: ctx.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env as Record<string, string>,
    });
    const timer = setTimeout(() => proc.kill(), c.timeoutMs ?? 120_000);
    const code = await proc.exited;
    clearTimeout(timer);
    const met = code === 0;
    return { label, met, detail: met ? 'exit 0' : `exit ${code}` };
  } catch (err) {
    return { label, met: false, detail: (err as Error).message };
  }
}

function evalFile(
  c: Extract<SuccessCriterion, { kind: 'file' }>,
  ctx: VerifyContext,
): CriterionResult {
  const label = c.label ?? `file ${c.path}`;
  const abs = join(ctx.cwd, c.path);
  const exists = existsSync(abs);
  const wantExists = c.exists ?? true;
  if (exists !== wantExists) {
    return { label, met: false, detail: wantExists ? 'missing' : 'should not exist' };
  }
  if (c.matches && exists) {
    try {
      const content = readFileSync(abs, 'utf8');
      const re = new RegExp(c.matches);
      const met = re.test(content);
      return { label, met, detail: met ? 'matched' : `no match for /${c.matches}/` };
    } catch (err) {
      return { label, met: false, detail: (err as Error).message };
    }
  }
  return { label, met: true, detail: 'ok' };
}

function evalRule(
  c: Extract<SuccessCriterion, { kind: 'rule' }>,
  ctx: VerifyContext,
): CriterionResult {
  const label = c.label ?? `rule /${c.pattern}/`;
  let re: RegExp;
  try {
    re = new RegExp(c.pattern);
  } catch (err) {
    return { label, met: false, detail: `bad pattern: ${(err as Error).message}` };
  }
  const files = walkTextFiles(ctx.cwd, 2000);
  for (const f of files) {
    try {
      if (re.test(readFileSync(f, 'utf8'))) return { label, met: true, detail: `found in ${f}` };
    } catch {
      /* skip */
    }
  }
  return { label, met: false, detail: 'pattern not found' };
}

async function evalJudge(
  c: Extract<SuccessCriterion, { kind: 'judge' }>,
  ctx: VerifyContext,
): Promise<CriterionResult> {
  const label = c.label ?? 'judge';
  if (!ctx.judgeProvider) return { label, met: false, detail: 'no provider for judging' };
  const prompt = [
    'You are a strict verifier. Inspect the current state of the working directory',
    'and decide whether ALL of the following criteria are satisfied:',
    '',
    c.rubric,
    '',
    'Reply with exactly one line: "PASS: <reason>" or "FAIL: <what is missing>".',
    'Do not make any changes. Be rigorous — if unsure, FAIL.',
  ].join('\n');
  const res = await ctx.harness.runAgent({
    provider: ctx.judgeProvider,
    ...(ctx.judgeModel ? { model: ctx.judgeModel } : {}),
    role: 'validator',
    title: 'Verify goal',
    prompt,
    cwd: ctx.cwd,
    autoApprove: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const line = res.text.trim().split('\n').find((l) => /\b(PASS|FAIL)\b/i.test(l)) ?? res.text.trim();
  const met = /^\s*PASS\b/i.test(line) || (/\bPASS\b/i.test(line) && !/\bFAIL\b/i.test(line));
  return { label, met, detail: line.slice(0, 200) };
}

/** Shallow-ish walk collecting text files, capped, skipping noise dirs. */
function walkTextFiles(root: string, cap: number): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', '.git', '.omks', 'dist', 'build', '.next', 'coverage']);
  const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.size < 512 * 1024) out.push(full);
    }
  }
  return out;
}
