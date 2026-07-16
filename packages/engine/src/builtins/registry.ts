// Static registry of built-in workflows. Importing the functions directly (vs.
// filesystem-scanning + dynamic import) means they are BUNDLED — so they work
// in a compiled single-file binary (`bun build --compile`), not just from source.

import type { WorkflowFn } from '../workflow-types.ts';
import goal from './goal.ts';
import auto from './auto.ts';
import mission from './mission.ts';
import tdd from './tdd.ts';
import review from './review.ts';
import research from './research.ts';
import parallel from './parallel.ts';
import solo from './solo.ts';

export interface BuiltinDef {
  name: string;
  description: string;
  version: string;
  whenToUse: string;
  fn: WorkflowFn;
}

export const BUILTINS: readonly BuiltinDef[] = [
  {
    name: 'goal',
    description: "General goal achiever — plan, build steps in a pipeline, then validate and fix until the goal's success criteria are met. The default workflow.",
    version: '0.1.0',
    whenToUse: 'Any open-ended objective where you want Omakase to plan and drive it to completion.',
    fn: goal,
  },
  {
    name: 'auto',
    description: 'Prompt self-orchestration — an orchestrator agent designs a bespoke multi-agent plan (a DAG of roles/prompts), which the engine executes with dependencies respected and independent steps run in parallel. The workflow writes itself.',
    version: '0.1.0',
    whenToUse: 'When you want Omakase to invent the orchestration for a goal instead of following a fixed workflow.',
    fn: auto,
  },
  {
    name: 'mission',
    description: 'Plan several features, build + review each independently in a pipeline, then loop-until-dry on remaining gaps.',
    version: '0.1.0',
    whenToUse: 'Larger efforts with multiple independent features to build and validate.',
    fn: mission,
  },
  {
    name: 'tdd',
    description: 'Red → Green → Refactor for each behaviour, run as an independent pipeline.',
    version: '0.1.0',
    whenToUse: 'When you want the work built strictly test-first.',
    fn: tdd,
  },
  {
    name: 'review',
    description: 'Review the working directory across several dimensions in parallel, adversarially verify findings, and report.',
    version: '0.1.0',
    whenToUse: 'To audit existing code for bugs, quality and security without changing it.',
    fn: review,
  },
  {
    name: 'research',
    description: 'Decompose a question, investigate sub-questions in parallel, then synthesize a cited answer.',
    version: '0.1.0',
    whenToUse: 'To research a topic or codebase question before acting.',
    fn: research,
  },
  {
    name: 'parallel',
    description: 'Plan independent components and build them concurrently, each in its OWN isolated subdirectory so agents never edit the same files.',
    version: '0.1.0',
    whenToUse: 'When the goal splits into independent pieces that can be built in parallel without conflicts.',
    fn: parallel,
  },
  {
    name: 'solo',
    description: 'One agent, one pass — the simplest workflow. Hand the whole goal to a single provider.',
    version: '0.1.0',
    whenToUse: "Small, self-contained tasks that don't need decomposition.",
    fn: solo,
  },
];
