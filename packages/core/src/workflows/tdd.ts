/**
 * The TDD loop state machine: red → green → refactor, cycling per behaviour.
 *
 *   red:      a new test is written and must FAIL first.
 *   green:    implement until the test passes.
 *   refactor: clean up while keeping tests green.
 *
 * Test runs drive the transitions; the loop tracks cycles and run history so a
 * worker agent (or a human) can be guided through disciplined TDD.
 */
export type TddPhase = 'red' | 'green' | 'refactor' | 'done';

export interface TestRun {
  passed: boolean;
  total?: number;
  failed?: number;
  label?: string;
}

export interface TddOptions {
  clock?: () => number;
}

export interface TddState {
  phase: TddPhase;
  cycle: number;
  history: Array<{ phase: TddPhase; run: TestRun; at: number }>;
  /** Set when a test unexpectedly passed during the red phase. */
  lastWarning: string | null;
}

export class TddLoop {
  private state: TddState;
  private readonly clock: () => number;

  constructor(options: TddOptions = {}) {
    this.clock = options.clock ?? (() => Date.now());
    this.state = { phase: 'red', cycle: 1, history: [], lastWarning: null };
  }

  get phase(): TddPhase {
    return this.state.phase;
  }
  get cycle(): number {
    return this.state.cycle;
  }
  get warning(): string | null {
    return this.state.lastWarning;
  }

  snapshot(): TddState {
    return { ...this.state, history: this.state.history.map((h) => ({ ...h })) };
  }

  /** Record a test run and return the resulting phase. */
  recordTestRun(run: TestRun): TddPhase {
    const fromPhase = this.state.phase;
    this.state.history.push({ phase: fromPhase, run, at: this.clock() });
    this.state.lastWarning = null;

    switch (fromPhase) {
      case 'red':
        if (run.passed) {
          // A test that passes immediately isn't exercising new behaviour.
          this.state.lastWarning = 'Test passed during red phase; it may not assert new behaviour.';
        } else {
          this.state.phase = 'green';
        }
        break;
      case 'green':
        if (run.passed) this.state.phase = 'refactor';
        break;
      case 'refactor':
        if (run.passed) {
          // Behaviour complete — begin the next cycle.
          this.state.phase = 'red';
          this.state.cycle += 1;
        } else {
          // A refactor broke the tests: regress to green.
          this.state.phase = 'green';
        }
        break;
      case 'done':
        throw new Error('TddLoop is already done');
    }
    return this.state.phase;
  }

  /** Mark the loop finished (allowed from red or refactor — i.e. tests green). */
  finish(): TddState {
    if (this.state.phase === 'green') {
      throw new Error('Cannot finish during green: implementation is incomplete');
    }
    this.state.phase = 'done';
    return this.snapshot();
  }

  isComplete(): boolean {
    return this.state.phase === 'done';
  }

  toJSON(): TddState {
    return this.snapshot();
  }

  static fromJSON(state: TddState, options: TddOptions = {}): TddLoop {
    const loop = new TddLoop(options);
    loop.state = { ...state, history: state.history.map((h) => ({ ...h })) };
    return loop;
  }
}
