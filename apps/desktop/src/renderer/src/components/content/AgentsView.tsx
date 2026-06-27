import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, RotateCw } from 'lucide-react';
import type { CockpitEvent } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Badge } from '../ui/badge';
import { StatusDot, type DotStatus } from '../StatusDot';
import { RUN_DOT } from '../runs/run-status';
import { TaskActivity } from '../runs/TaskActivity';
import { ContentLayout, EmptyDetail } from './ContentLayout';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'incomplete']);

interface AgentRow {
  agentRunId: string;
  role: string;
  agentId: string;
  model: string | null;
  taskId?: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  /** Highest attempt seen — >1 means the task was retried on this same agent. */
  attempts?: number;
}

const AGENT_DOT: Record<AgentRow['status'], DotStatus> = {
  running: 'omk',
  done: 'run',
  failed: 'fail',
};

/** Reconstruct the run's sub-agent roster from its cockpit feed. */
function deriveRoster(feed: CockpitEvent[], runTerminal: boolean): AgentRow[] {
  const finished = new Set<string>();
  const failed = new Set<string>();
  for (const e of feed) {
    if (e.kind === 'task' && e.taskId) {
      if (e.status === 'succeeded') finished.add(e.taskId);
      else if (e.status === 'failed' || e.status === 'cancelled') {
        finished.add(e.taskId);
        failed.add(e.taskId);
      }
    }
  }
  // The latest 'agent' event per agent wins: agent-assigned (status 'running')
  // then the terminal done event (status 'done'/'failed'/'cancelled').
  const byAgent = new Map<string, Omit<AgentRow, 'status'> & { eventStatus?: string }>();
  for (const e of feed) {
    if (e.kind !== 'agent' || !e.agentRunId) continue;
    const prev = byAgent.get(e.agentRunId);
    if (prev) {
      // Later events update the status (terminal 'done', or a retry's fresh
      // 'running') and the attempt count; the first event (agent-assigned)
      // keeps the descriptive task title/CLI/model.
      prev.eventStatus = e.status;
      if (e.attempts && e.attempts > (prev.attempts ?? 1)) prev.attempts = e.attempts;
    } else {
      byAgent.set(e.agentRunId, {
        agentRunId: e.agentRunId,
        role: e.role ?? 'worker',
        agentId: e.agentId ?? 'builtin',
        model: e.model ?? null,
        taskId: e.taskId,
        title: e.title,
        eventStatus: e.status,
        ...(e.attempts ? { attempts: e.attempts } : {}),
      });
    }
  }
  return [...byAgent.values()].map((a): AgentRow => {
    let status: AgentRow['status'];
    if (a.eventStatus === 'failed') status = 'failed';
    else if (a.eventStatus === 'done' || a.eventStatus === 'cancelled') status = 'done';
    else if (a.taskId && failed.has(a.taskId)) status = 'failed';
    else if (a.taskId && finished.has(a.taskId)) status = 'done';
    else if (runTerminal) status = 'done';
    else status = 'running';
    return {
      agentRunId: a.agentRunId,
      role: a.role,
      agentId: a.agentId,
      model: a.model,
      taskId: a.taskId,
      title: a.title,
      status,
      ...(a.attempts ? { attempts: a.attempts } : {}),
    };
  });
}

export function AgentsView() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const runs = useAppStore((s) => s.runs);
  const currentRunId = useAppStore((s) => s.currentRunId);
  const liveFeed = useAppStore((s) => s.feed);
  const loadRuns = useAppStore((s) => s.loadRuns);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [snapshotFeed, setSnapshotFeed] = useState<CockpitEvent[]>([]);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  useEffect(() => {
    void loadRuns();
  }, [activePath, loadRuns]);

  // Default the selection to the open run, else the most recent.
  useEffect(() => {
    setSelectedRunId((cur) => {
      if (cur && runs.some((r) => r.id === cur)) return cur;
      return currentRunId ?? runs[0]?.id ?? null;
    });
  }, [runs, currentRunId]);

  // A non-current run shows a snapshot of its persisted feed; the current run streams live.
  const isCurrent = selectedRunId != null && selectedRunId === currentRunId;
  useEffect(() => {
    if (!selectedRunId || isCurrent) return;
    let cancelled = false;
    void window.omakase.runs.get(selectedRunId).then((detail) => {
      if (!cancelled) setSnapshotFeed(detail?.events ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, isCurrent]);

  const selectedRun = runs.find((r) => r.id === selectedRunId);
  const feed = isCurrent ? liveFeed : snapshotFeed;
  const roster = useMemo(
    () => deriveRoster(feed, selectedRun ? TERMINAL.has(selectedRun.status) : false),
    [feed, selectedRun],
  );
  const liveCount = roster.filter((a) => a.status === 'running').length;

  return (
    <ContentLayout title="Agents">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('Runs')}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {runs.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
              {t('No runs yet. Agents appear here as a run spawns them.')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {runs.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedRunId(r.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                    selectedRunId === r.id ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <StatusDot
                    status={RUN_DOT[r.status] ?? 'idle'}
                    pulse={r.status === 'running'}
                    glow={r.live && r.status === 'running'}
                  />
                  <span className="flex-1 truncate text-[13px]">{r.summary || t('Run')}</span>
                  {r.live && <span className="text-[10px] uppercase tracking-wide text-run">live</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedRun ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
            <span className="truncate text-[13px] font-medium">{selectedRun.summary || t('Run')}</span>
            <Badge variant={selectedRun.live ? 'run' : 'outline'}>{selectedRun.status}</Badge>
            <span className="ml-auto text-[12px] text-muted-foreground">
              {roster.length} agent{roster.length === 1 ? '' : 's'}
              {liveCount > 0 && <span className="text-run"> · {liveCount} live</span>}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {roster.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="max-w-xs text-center text-[12px] leading-relaxed text-muted-foreground">
                  {t(
                    'No sub-agents yet. The orchestrator spawns planner, worker, reviewer and validator agents as this run progresses.',
                  )}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {roster.map((a) => {
                  const expanded = expandedAgent === a.agentRunId;
                  return (
                    <div key={a.agentRunId} className="overflow-hidden rounded-lg border bg-card">
                      <button
                        onClick={() => setExpandedAgent(expanded ? null : a.agentRunId)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent/30"
                      >
                        <ChevronRight
                          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
                        />
                        <StatusDot
                          status={AGENT_DOT[a.status]}
                          pulse={a.status === 'running'}
                          glow={a.status === 'running'}
                        />
                        <Badge variant="outline" className="shrink-0">
                          {a.role}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px]">{a.title}</div>
                          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                            <span>{a.agentId}</span>
                            {a.model && <span>· {a.model}</span>}
                          </div>
                        </div>
                        {a.attempts && a.attempts > 1 && (
                          <span
                            className="flex shrink-0 items-center gap-0.5 text-[11px] text-warn"
                            title={t('Retried on the same agent')}
                          >
                            <RotateCw className="size-3" />
                            {a.attempts - 1}
                          </span>
                        )}
                        <span className="shrink-0 text-[11px] capitalize text-muted-foreground">{a.status}</span>
                      </button>
                      {expanded && (
                        <div className="border-t bg-background/40 px-3 py-1.5">
                          <TaskActivity feed={feed} taskId={a.taskId} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <EmptyDetail message="Agents are spawned by runs — start a run, and its planner/worker/reviewer/validator agents appear here live." />
      )}
    </ContentLayout>
  );
}
