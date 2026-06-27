/**
 * Triggers (automations) make runs self-starting — the basis for unattended,
 * self-iterating loops. A trigger fires on an interval or on file changes and
 * starts a run from a spec or prompt. Persisted as `.omks/triggers.json` so the
 * scheduler can restore them across app restarts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { omksDir } from './workspace.js';

export type TriggerKind = 'interval' | 'daily' | 'watch';

export interface Trigger {
  id: string;
  name: string;
  enabled: boolean;
  kind: TriggerKind;
  /** Source of the run: a spec id, or a free prompt. */
  specId?: string;
  prompt?: string;
  /** Run config. */
  mode: 'normal' | 'max-power';
  autonomy: 'off' | 'low' | 'medium' | 'high';
  agentId?: string;
  /** Hard token budget for each run this trigger starts. */
  maxTokens?: number;
  /** kind === 'interval': minutes between fires. */
  intervalMinutes?: number;
  /** kind === 'daily': local time of day to fire, "HH:MM". */
  dailyTime?: string;
  /** kind === 'watch': quiet period after the last change before firing. */
  debounceMs?: number;
  /** Last time the scheduler fired this trigger. */
  lastFiredAt?: number;
}

const triggersFile = (root: string): string => path.join(omksDir(root), 'triggers.json');

export function listTriggers(root: string): Trigger[] {
  try {
    const raw = JSON.parse(readFileSync(triggersFile(root), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(isTrigger);
  } catch {
    return [];
  }
}

function writeTriggers(root: string, triggers: Trigger[]): void {
  mkdirSync(omksDir(root), { recursive: true });
  writeFileSync(triggersFile(root), `${JSON.stringify(triggers, null, 2)}\n`, 'utf8');
}

export interface SaveTriggerInput {
  id?: string;
  name: string;
  enabled?: boolean;
  kind: TriggerKind;
  specId?: string;
  prompt?: string;
  mode?: 'normal' | 'max-power';
  autonomy?: 'off' | 'low' | 'medium' | 'high';
  agentId?: string;
  maxTokens?: number;
  intervalMinutes?: number;
  dailyTime?: string;
  debounceMs?: number;
}

export function saveTrigger(root: string, input: SaveTriggerInput): Trigger {
  const triggers = listTriggers(root);
  const id = input.id ?? randomUUID();
  const existing = triggers.find((t) => t.id === id);
  const trigger: Trigger = {
    id,
    name: input.name.trim() || 'Automation',
    enabled: input.enabled ?? existing?.enabled ?? false,
    kind: input.kind,
    specId: input.specId,
    prompt: input.prompt,
    mode: input.mode ?? existing?.mode ?? 'normal',
    autonomy: input.autonomy ?? existing?.autonomy ?? 'medium',
    agentId: input.agentId,
    maxTokens: input.maxTokens ?? existing?.maxTokens,
    intervalMinutes: input.intervalMinutes ?? existing?.intervalMinutes ?? 30,
    dailyTime: input.dailyTime ?? existing?.dailyTime ?? '02:00',
    debounceMs: input.debounceMs ?? existing?.debounceMs ?? 5000,
    lastFiredAt: existing?.lastFiredAt,
  };
  const next = existing ? triggers.map((t) => (t.id === id ? trigger : t)) : [...triggers, trigger];
  writeTriggers(root, next);
  return trigger;
}

export function deleteTrigger(root: string, id: string): void {
  writeTriggers(root, listTriggers(root).filter((t) => t.id !== id));
}

/** Record a fire timestamp (called by the scheduler). */
export function markTriggerFired(root: string, id: string, at: number): void {
  const triggers = listTriggers(root);
  const next = triggers.map((t) => (t.id === id ? { ...t, lastFiredAt: at } : t));
  writeTriggers(root, next);
}

function isTrigger(v: unknown): v is Trigger {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    (t.kind === 'interval' || t.kind === 'watch')
  );
}
