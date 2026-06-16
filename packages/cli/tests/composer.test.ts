import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/composer.js';

describe('parseInput', () => {
  it('classifies blank, bash, command, workflow and task', () => {
    expect(parseInput('  ')).toEqual({ kind: 'empty' });
    expect(parseInput('!ls -la')).toEqual({ kind: 'bash', command: 'ls -la' });
    expect(parseInput('/stop')).toEqual({ kind: 'command', name: 'stop', args: '' });
    expect(parseInput('/agent claude')).toEqual({ kind: 'command', name: 'agent', args: 'claude' });
    expect(parseInput('/workflow review the diff')).toEqual({ kind: 'workflow', source: 'review the diff' });
    expect(parseInput('add OAuth')).toEqual({ kind: 'task', prompt: 'add OAuth', files: [] });
  });

  it('extracts inline @agent and #file from a task and strips them', () => {
    expect(parseInput('@codex refactor #src/a.ts and #src/b.ts')).toEqual({
      kind: 'task',
      prompt: 'refactor and',
      agentOverride: 'codex',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('does not treat a mid-word @ (email) as an agent override', () => {
    expect(parseInput('mail me@x.com')).toEqual({ kind: 'task', prompt: 'mail me@x.com', files: [] });
  });
});
