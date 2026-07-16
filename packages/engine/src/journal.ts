// Portable per-run event journal: mirrors each run's events to a JSONL file
// under .omks/runs/. Complements the SQLite store — greppable, diffable, and a
// backstop if the database is unavailable.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyRunEvent, RunId } from '@omakase/core';

export class Journal {
  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort */
    }
  }

  path(runId: RunId): string {
    return join(this.dir, `${runId}.jsonl`);
  }

  append(event: AnyRunEvent): void {
    try {
      appendFileSync(this.path(event.runId), JSON.stringify(event) + '\n');
    } catch {
      /* journaling must never break a run */
    }
  }
}
