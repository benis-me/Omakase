// @omakase/engine — dynamic-workflow runtime, goal-loop, resume, durable retry.

export type {
  WorkflowContext,
  WorkflowFn,
  AgentSpec,
  AgentResult,
  ReportSpec,
  WikiSpec,
  PipelineStage,
  AskRequest,
  Answerer,
} from './workflow-types.ts';

export { WorkflowRuntime, type RuntimeDeps } from './runtime.ts';
export { SubprocessHarness, MockHarness, type Harness, type HarnessRequest, type HarnessResult } from './harness.ts';
export { RunBus, subscribeRun, type RunEventListener } from './bus.ts';
export { withRetry, FatalError, type RetryOptions } from './retry.ts';
export { Semaphore } from './semaphore.ts';

export {
  discoverWorkflows,
  findWorkflow,
  loadWorkflow,
  scanDir,
  BUILTIN_DIR,
  type WorkflowMeta,
  type LoadedWorkflow,
  type WorkflowScope,
  type DiscoverDirs,
} from './workflows.ts';

export {
  parseFrontmatter,
  parseCommentMeta,
  asString,
  asStringArray,
  type Frontmatter,
} from './frontmatter.ts';

export { isGitRepo, createWorktree, commitAndMerge, removeWorktree, GitSerializer, type Worktree } from './isolate.ts';
export { verifyGoal, type VerifyContext, type VerifyResult, type CriterionResult } from './verify.ts';
export { buildResumeState, type ResumeState } from './resume.ts';
export { Journal } from './journal.ts';
export { crystallize, type Crystallized } from './crystallize.ts';
export { lintWorkflow, codeOnly, type Finding, type LintResult } from './lint.ts';
export { makeSystemPromptFactory } from './prompt.ts';

export {
  runGoal,
  resumeRun,
  DEFAULT_PROVIDER_PREFERENCE,
  type RunGoalOptions,
  type RunOutcome,
} from './orchestrator.ts';
