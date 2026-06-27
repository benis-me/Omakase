import { useEffect, useMemo, useState } from 'react';
import type { AcceptanceView, CockpitEvent } from '@shared/types';
import { cn } from '@/lib/utils';
import { useT } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarkdownPreview } from '@/components/ui/markdown-preview';
import { StatusDot, type DotStatus } from '../StatusDot';
import { CockpitFeed } from './CockpitFeed';

const TASK_DOT: Record<string, DotStatus> = {
  running: 'omk',
  succeeded: 'run',
  done: 'run',
  failed: 'fail',
  blocked: 'warn',
  pending: 'idle',
  cancelled: 'idle',
};

const CRITERION_DOT: Record<AcceptanceView['criteria'][number]['status'], DotStatus> = {
  pass: 'run',
  fail: 'fail',
  pending: 'idle',
  unknown: 'warn',
  'needs-user': 'warn',
};

type TabId = 'activity' | 'tasks' | 'acceptance' | 'reports' | 'knowledge' | 'diffs';

/** The workspace's working-tree diff (what the run changed), with +/- coloring. */
function DiffsPanel() {
  const t = useT();
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    void window.omakase.git.diff().then(setDiff);
  }, []);
  if (diff === null)
    return (
      <div className="flex h-full items-center justify-center p-8 text-[12px] text-muted-foreground">
        {t('Loading diff…')}
      </div>
    );
  if (!diff.trim())
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-xs text-center text-[12px] leading-relaxed text-muted-foreground">
          {t('No uncommitted changes in the workspace.')}
        </p>
      </div>
    );
  return (
    <div className="h-full overflow-auto p-3">
      <pre className="font-mono text-[12px] leading-relaxed">
        {diff.split('\n').map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith('@@')
                ? 'text-omk'
                : line.startsWith('+') && !line.startsWith('+++')
                  ? 'text-run'
                  : line.startsWith('-') && !line.startsWith('---')
                    ? 'text-destructive'
                    : line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')
                      ? 'text-muted-foreground'
                      : '',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

interface TaskRow {
  title: string;
  status: string;
  role?: string;
}

function EmptyPanel({ children }: { children: string }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <p className="max-w-xs text-center text-[12px] leading-relaxed text-muted-foreground">{t(children)}</p>
    </div>
  );
}

function TasksPanel({ tasks }: { tasks: TaskRow[] }) {
  if (tasks.length === 0) return <EmptyPanel>No tasks yet — the planner will break the work down here.</EmptyPanel>;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="flex flex-col gap-0.5">
        {tasks.map((task) => (
          <div key={task.title} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
            <StatusDot status={TASK_DOT[task.status] ?? 'idle'} pulse={task.status === 'running'} />
            <span className="flex-1 truncate text-[13px]">{task.title}</span>
            {task.role && <Badge variant="outline">{task.role}</Badge>}
            <span className="w-16 shrink-0 text-right text-[11px] capitalize text-muted-foreground">
              {task.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AcceptancePanel({ acceptance }: { acceptance: AcceptanceView | null }) {
  const t = useT();
  if (!acceptance || acceptance.criteria.length === 0)
    return <EmptyPanel>No acceptance criteria yet — they appear once a spec drives the run, or the agent authors one.</EmptyPanel>;
  const adopted = acceptance.criteria.filter((c) => c.source === 'spec').length;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2 px-2 text-[12px] text-muted-foreground">
        <span className="font-medium tabular-nums text-foreground">
          {acceptance.passed}/{acceptance.total}
        </span>
        <span>{t('criteria met')}</span>
        {adopted > 0 && (
          <Badge variant="outline" className="ml-auto text-omk">
            {adopted} {t('from agent spec')}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        {acceptance.criteria.map((c, i) => (
          <div key={i} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
            <span className="mt-1">
              <StatusDot status={CRITERION_DOT[c.status]} pulse={false} />
            </span>
            <span className="flex-1 text-[13px] leading-relaxed">{c.title}</span>
            {c.source === 'spec' && (
              <Badge variant="outline" className="shrink-0 text-[10px] text-omk">
                {t('agent spec')}
              </Badge>
            )}
            <span className="w-12 shrink-0 text-right text-[11px] capitalize text-muted-foreground">
              {t(c.status)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportsPanel({ reports }: { reports: CockpitEvent[] }) {
  const t = useT();
  if (reports.length === 0)
    return <EmptyPanel>No reports yet — the reporter writes summaries here as the run progresses.</EmptyPanel>;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="flex flex-col gap-3">
        {reports.map((r) => (
          <Card key={r.seq}>
            <CardHeader className="p-3 pb-0">
              <CardTitle className="text-[13px]">{r.title.replace(/^Report:\s*/, '')}</CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              {r.detail ? (
                <MarkdownPreview source={r.detail} />
              ) : (
                <p className="text-[12px] text-muted-foreground">{t('No content.')}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function KnowledgePanel({ items }: { items: CockpitEvent[] }) {
  if (items.length === 0)
    return <EmptyPanel>No knowledge captured yet — agents record what they learn here.</EmptyPanel>;
  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="flex flex-col gap-2">
        {items.map((k) => {
          const [kind, ...rest] = k.title.split(':');
          const title = rest.join(':').trim() || k.title;
          return (
            <Card key={k.seq}>
              <CardHeader className="flex-row items-center gap-2 p-3 pb-0">
                <Badge variant="outline">{kind}</Badge>
                <CardTitle className="text-[13px]">{title}</CardTitle>
              </CardHeader>
              {k.detail && (
                <CardContent className="p-3 pt-2">
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{k.detail}</p>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function CockpitTabs({ feed, acceptance }: { feed: CockpitEvent[]; acceptance: AcceptanceView | null }) {
  const t = useT();
  const [tab, setTab] = useState<TabId>('activity');

  const tasks = useMemo<TaskRow[]>(() => {
    const map = new Map<string, TaskRow>();
    for (const e of feed) {
      if (e.kind === 'task') {
        map.set(e.title, { title: e.title, status: e.status ?? 'running', role: e.role });
      }
    }
    return [...map.values()];
  }, [feed]);
  const reports = useMemo(() => feed.filter((e) => e.kind === 'report'), [feed]);
  const knowledge = useMemo(() => feed.filter((e) => e.kind === 'knowledge'), [feed]);

  const tabs: { id: TabId; label: string; count: number }[] = [
    { id: 'activity', label: 'Activity', count: feed.length },
    { id: 'tasks', label: 'Tasks', count: tasks.length },
    { id: 'acceptance', label: 'Acceptance', count: acceptance?.total ?? 0 },
    { id: 'reports', label: 'Reports', count: reports.length },
    { id: 'knowledge', label: 'Knowledge', count: knowledge.length },
    { id: 'diffs', label: 'Diffs', count: 0 },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
              tab === tb.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t(tb.label)}
            {tb.count > 0 && <span className="text-[10px] tabular-nums text-muted-foreground">{tb.count}</span>}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'activity' && <CockpitFeed feed={feed} />}
        {tab === 'tasks' && <TasksPanel tasks={tasks} />}
        {tab === 'acceptance' && <AcceptancePanel acceptance={acceptance} />}
        {tab === 'reports' && <ReportsPanel reports={reports} />}
        {tab === 'knowledge' && <KnowledgePanel items={knowledge} />}
        {tab === 'diffs' && <DiffsPanel />}
      </div>
    </div>
  );
}
