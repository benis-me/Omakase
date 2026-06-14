import { describe, expect, it } from 'vitest';
import { composeSessionPrompt, parseComposerInput } from '../src/composer-parse.js';

describe('parseComposerInput', () => {
  it('treats blank input as empty', () => {
    expect(parseComposerInput('   ')).toEqual({ kind: 'empty' });
  });

  it('parses a plain natural-language task', () => {
    expect(parseComposerInput('add OAuth to login')).toEqual({
      kind: 'task',
      prompt: 'add OAuth to login',
      files: [],
    });
  });

  it('extracts a leading/inline @agent override and strips it from the prompt', () => {
    expect(parseComposerInput('@codex refactor the parser')).toEqual({
      kind: 'task',
      prompt: 'refactor the parser',
      agentOverride: 'codex',
      files: [],
    });
  });

  it('collects #file references and strips them from the prompt', () => {
    expect(parseComposerInput('explain #src/a.ts and #src/b.ts please')).toEqual({
      kind: 'task',
      prompt: 'explain and please',
      files: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('routes /workflow to a workflow intent', () => {
    expect(parseComposerInput('/workflow review the diff')).toEqual({
      kind: 'workflow',
      source: 'review the diff',
    });
  });

  it('parses other slash commands with name + args', () => {
    expect(parseComposerInput('/agent claude')).toEqual({ kind: 'command', name: 'agent', args: 'claude' });
    expect(parseComposerInput('/stop')).toEqual({ kind: 'command', name: 'stop', args: '' });
  });

  it('does not treat a mid-word @ (e.g. email) as an agent override', () => {
    expect(parseComposerInput('email me@example.com the report')).toEqual({
      kind: 'task',
      prompt: 'email me@example.com the report',
      files: [],
    });
  });
});

describe('composeSessionPrompt', () => {
  it('returns the bare prompt when there is no summary or files', () => {
    expect(composeSessionPrompt({ prompt: 'do X', files: [] }, '')).toBe('do X');
  });

  it('prepends a session-context block when a rolling summary exists', () => {
    const out = composeSessionPrompt({ prompt: 'do X', files: [] }, 'we built Y');
    expect(out).toContain('Session context so far:');
    expect(out).toContain('we built Y');
    expect(out.trimEnd().endsWith('do X')).toBe(true);
  });

  it('appends a context-files list when files are referenced', () => {
    const out = composeSessionPrompt({ prompt: 'do X', files: ['a.ts', 'b.ts'] }, '');
    expect(out).toContain('Context files:');
    expect(out).toContain('- a.ts');
    expect(out).toContain('- b.ts');
  });
});
