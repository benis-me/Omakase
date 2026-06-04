import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface TuiPreferences {
  selectedAgent: string | null;
}

const DEFAULT_PREFS: TuiPreferences = { selectedAgent: null };

function prefsFile(cwd: string): string {
  return path.join(cwd, '.omakase', 'tui-preferences.json');
}

export function loadTuiPreferences(cwd: string): TuiPreferences {
  try {
    const parsed = JSON.parse(readFileSync(prefsFile(cwd), 'utf8')) as Partial<TuiPreferences>;
    return {
      selectedAgent:
        typeof parsed.selectedAgent === 'string' && parsed.selectedAgent.trim()
          ? parsed.selectedAgent
          : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveTuiPreferences(cwd: string, prefs: TuiPreferences): void {
  try {
    const file = prefsFile(cwd);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`, 'utf8');
  } catch {
    // Preferences improve continuity but must never break the TUI on read-only
    // or synthetic test paths.
  }
}
