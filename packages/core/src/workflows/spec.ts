/**
 * The spec-driven workflow state machine:
 *
 *   idea → spec → acceptance criteria → test plan → implementation tasks → done
 *
 * Each phase has a content guard; you fill the current phase's artifact and
 * then `advance()`. Transitions are recorded so the workflow is auditable and
 * serializable.
 */
export type SpecPhase = 'idea' | 'spec' | 'acceptance' | 'test-plan' | 'tasks' | 'done';

export const SPEC_PHASES: readonly SpecPhase[] = [
  'idea',
  'spec',
  'acceptance',
  'test-plan',
  'tasks',
  'done',
];

export interface SpecTransition {
  from: SpecPhase;
  to: SpecPhase;
  at: number;
}

export interface SpecState {
  phase: SpecPhase;
  idea: string;
  spec: string;
  acceptanceCriteria: string[];
  testPlan: string[];
  tasks: string[];
  history: SpecTransition[];
}

export interface SpecWorkflowOptions {
  clock?: () => number;
}

export class SpecWorkflow {
  private state: SpecState;
  private readonly clock: () => number;

  constructor(idea: string, options: SpecWorkflowOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.state = {
      phase: 'idea',
      idea,
      spec: '',
      acceptanceCriteria: [],
      testPlan: [],
      tasks: [],
      history: [],
    };
  }

  get phase(): SpecPhase {
    return this.state.phase;
  }

  snapshot(): SpecState {
    return {
      ...this.state,
      acceptanceCriteria: [...this.state.acceptanceCriteria],
      testPlan: [...this.state.testPlan],
      tasks: [...this.state.tasks],
      history: this.state.history.map((h) => ({ ...h })),
    };
  }

  setSpec(text: string): this {
    this.state.spec = text;
    return this;
  }
  addAcceptanceCriterion(text: string): this {
    this.state.acceptanceCriteria.push(text);
    return this;
  }
  addTest(text: string): this {
    this.state.testPlan.push(text);
    return this;
  }
  addTask(text: string): this {
    this.state.tasks.push(text);
    return this;
  }

  /** True when the current phase has the content needed to advance. */
  canAdvance(): boolean {
    switch (this.state.phase) {
      case 'idea':
        return this.state.idea.trim().length > 0;
      case 'spec':
        return this.state.spec.trim().length > 0;
      case 'acceptance':
        return this.state.acceptanceCriteria.length > 0;
      case 'test-plan':
        return this.state.testPlan.length > 0;
      case 'tasks':
        return this.state.tasks.length > 0;
      case 'done':
        return false;
    }
  }

  advance(): SpecState {
    if (this.state.phase === 'done') {
      throw new Error('SpecWorkflow is already done');
    }
    if (!this.canAdvance()) {
      throw new Error(`Cannot advance from "${this.state.phase}": phase content is incomplete`);
    }
    const from = this.state.phase;
    const idx = SPEC_PHASES.indexOf(from);
    const to = SPEC_PHASES[idx + 1]!;
    this.state.phase = to;
    this.state.history.push({ from, to, at: this.clock() });
    return this.snapshot();
  }

  isComplete(): boolean {
    return this.state.phase === 'done';
  }

  toJSON(): SpecState {
    return this.snapshot();
  }

  static fromJSON(state: SpecState, options: SpecWorkflowOptions = {}): SpecWorkflow {
    const wf = new SpecWorkflow(state.idea, options);
    wf.state = {
      ...state,
      acceptanceCriteria: [...state.acceptanceCriteria],
      testPlan: [...state.testPlan],
      tasks: [...state.tasks],
      history: state.history.map((h) => ({ ...h })),
    };
    return wf;
  }
}
