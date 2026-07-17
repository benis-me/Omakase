import { test, expect } from 'bun:test';
import { agentTag, type AnyRunEvent, type RunEventType, type RunEventPayloadMap, type RunId } from '@omakase/core';
import { createEventRenderer, exitCodeFor } from './ui.ts';

let seq = 0;
function ev<T extends RunEventType>(type: T, payload: RunEventPayloadMap[T]): AnyRunEvent {
  return { runId: 'run_test' as RunId, seq: seq++, type, payload, createdAt: 0 } as AnyRunEvent;
}
const started = (callId: string) =>
  ev('agent:started', {
    callId,
    stepKey: 's',
    role: 'worker',
    title: 'Build it',
    provider: 'claude',
    model: null,
    prompt: 'do it',
    attempt: 1,
  });
const failed = (callId: string, error: string) => ev('agent:failed', { callId, stepKey: 's', error, attempt: 1 });

test('agentTag: an agent is shown by its own id, not an invented marker', () => {
  expect(agentTag('agt_q298tw')).toBe('q298tw');
});

test('exitCodeFor: a cancel exits 130 (Ctrl-C convention), success 0, failure 1', () => {
  expect(exitCodeFor('cancelled')).toBe(130);
  expect(exitCodeFor('succeeded')).toBe(0);
  expect(exitCodeFor('failed')).toBe(1);
});

test('render: a cancel drops the steps that never started, keeps the one that did', () => {
  const render = createEventRenderer();
  render(started('agt_aaaaaa'));
  // The agent that was actually in flight when the cancel landed.
  expect(render(failed('agt_aaaaaa', 'aborted'))).toContain('aborted');
  // The steps the workflow had queued behind it: turned away before they ran.
  expect(render(failed('agt_bbbbbb', 'aborted'))).toBeNull();
  expect(render(failed('agt_cccccc', 'aborted'))).toBeNull();
});

test('render: a budget denial stays visible even though it never started', () => {
  const render = createEventRenderer();
  // Nothing else says why a run stopped short of its goal.
  const line = render(failed('agt_dddddd', 'budget: max agents reached'));
  expect(line).toContain('max agents reached');
});

test('render: ids appear on child lines only once a run has gone parallel', () => {
  const render = createEventRenderer();
  render(started('agt_aaaaaa'));
  // Sequential so far — an id on every line would be noise.
  expect(render(failed('agt_aaaaaa', 'boom'))).not.toContain('aaaaaa');

  const parallel = createEventRenderer();
  parallel(started('agt_aaaaaa'));
  parallel(started('agt_bbbbbb'));
  expect(parallel(failed('agt_aaaaaa', 'boom'))).toContain('aaaaaa');
});
