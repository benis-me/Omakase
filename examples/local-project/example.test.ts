import { describe, expect, it } from 'vitest';
import { runDemo } from './run.js';

describe('local-project example', () => {
  it('runs end to end offline and produces knowledge', async () => {
    const lines: string[] = [];
    const result = await runDemo({
      cwd: import.meta.dirname,
      write: (line) => lines.push(line),
      // Scope detection so the example is deterministic regardless of machine.
      detection: { env: { PATH: '' }, includeWellKnownPathDirs: false },
    });

    expect(result.runStatus).toBe('succeeded');
    expect(result.taskCount).toBeGreaterThan(0);
    expect(result.succeededTasks).toBe(result.taskCount);
    expect(result.codegraphFiles).toBeGreaterThan(0);
    expect(result.wikiEntries).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('Orchestrating a task');
  });
});
