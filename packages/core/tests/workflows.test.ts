import { describe, expect, it } from 'vitest';
import { SpecWorkflow } from '../src/workflows/spec.js';
import { TddLoop } from '../src/workflows/tdd.js';

describe('SpecWorkflow', () => {
  it('advances through every phase with content guards', () => {
    const wf = new SpecWorkflow('Build a CLI', { clock: () => 0 });
    expect(wf.phase).toBe('idea');
    wf.advance();
    expect(wf.phase).toBe('spec');

    expect(() => wf.advance()).toThrow(/incomplete/);
    wf.setSpec('A CLI with agents/run/tui commands').advance();
    expect(wf.phase).toBe('acceptance');

    wf.addAcceptanceCriterion('lists agents').advance();
    expect(wf.phase).toBe('test-plan');

    wf.addTest('agents command prints a table').advance();
    expect(wf.phase).toBe('tasks');

    wf.addTask('implement agents command').advance();
    expect(wf.phase).toBe('done');
    expect(wf.isComplete()).toBe(true);
    expect(() => wf.advance()).toThrow(/already done/);
  });

  it('round-trips through JSON', () => {
    const wf = new SpecWorkflow('idea', { clock: () => 0 });
    wf.advance();
    wf.setSpec('spec text');
    const restored = SpecWorkflow.fromJSON(wf.toJSON(), { clock: () => 0 });
    expect(restored.phase).toBe('spec');
    restored.advance();
    expect(restored.phase).toBe('acceptance');
  });
});

describe('TddLoop', () => {
  it('drives red → green → refactor and starts the next cycle', () => {
    const loop = new TddLoop({ clock: () => 0 });
    expect(loop.phase).toBe('red');

    expect(loop.recordTestRun({ passed: false })).toBe('green');
    expect(loop.recordTestRun({ passed: false })).toBe('green'); // still implementing
    expect(loop.recordTestRun({ passed: true })).toBe('refactor');
    expect(loop.recordTestRun({ passed: true })).toBe('red'); // cycle complete
    expect(loop.cycle).toBe(2);
  });

  it('warns when a test passes during red and does not advance', () => {
    const loop = new TddLoop({ clock: () => 0 });
    expect(loop.recordTestRun({ passed: true })).toBe('red');
    expect(loop.warning).toMatch(/red phase/i);
  });

  it('regresses to green if a refactor breaks tests', () => {
    const loop = new TddLoop({ clock: () => 0 });
    loop.recordTestRun({ passed: false }); // -> green
    loop.recordTestRun({ passed: true }); // -> refactor
    expect(loop.recordTestRun({ passed: false })).toBe('green');
  });

  it('refuses to finish while green', () => {
    const loop = new TddLoop({ clock: () => 0 });
    loop.recordTestRun({ passed: false }); // -> green
    expect(() => loop.finish()).toThrow(/incomplete/);
  });
});
