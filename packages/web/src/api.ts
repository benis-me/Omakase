// Client for the `omks web` API server. Types mirror the server responses,
// kept local so the browser bundle stays decoupled from the Bun packages.

export interface RunSummary {
  id: string;
  sessionId: string | null;
  status: string;
  workflow: string;
  title: string;
  summary: string | null;
  spentAgents: number;
  spentTokens: number;
  spentCostUsd: number;
  createdAt: number;
  updatedAt: number;
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: any;
  createdAt: number;
}

export interface ProviderInfo {
  id: string;
  label: string;
  available: boolean;
  version: string | null;
  models: string[];
}

export interface WorkflowMeta {
  name: string;
  version: string;
  scope: string;
  description: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

export interface DashboardState {
  providers: ProviderInfo[];
  workflows: WorkflowMeta[];
  runs: RunSummary[];
  sessions: SessionMeta[];
  workspace: { name: string; root: string };
}

export interface RunDetail {
  run: RunSummary & { goal: { text: string } };
  events: RunEvent[];
  reports: { kind: string; title: string; summary: string }[];
}

/** The launch payload — mirrors the flags `omks run` accepts. */
export interface RunOptions {
  text: string;
  workflow?: string;
  provider?: string;
  model?: string;
  checks?: string[];
  criteria?: string[];
  maxAgents?: number;
  maxUsd?: number;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res
      .json()
      .then((b: { error?: string }) => b?.error)
      .catch(() => null);
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  state: () => json<DashboardState>('/api/state'),
  run: (id: string, after = 0) => json<RunDetail>(`/api/runs/${id}?after=${after}`),
  start: (opts: RunOptions) =>
    json<{ runId: string }>('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    }),
  cancel: (id: string) => json<{ ok: boolean }>(`/api/runs/${id}/cancel`, { method: 'POST' }),
};
