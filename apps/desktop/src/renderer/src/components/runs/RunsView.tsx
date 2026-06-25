import { useEffect } from 'react';
import { Play, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { StatusDot } from '../StatusDot';
import { Cockpit, RUN_DOT } from './Cockpit';

export function RunsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const runs = useAppStore((s) => s.runs);
  const currentRunId = useAppStore((s) => s.currentRunId);
  const loadRuns = useAppStore((s) => s.loadRuns);
  const openRun = useAppStore((s) => s.openRun);
  const closeRun = useAppStore((s) => s.closeRun);
  const resumeRun = useAppStore((s) => s.resumeRun);

  useEffect(() => {
    void loadRuns();
  }, [activePath, loadRuns]);

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <h2 className="text-[13px] font-medium">Runs</h2>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={closeRun}
          >
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {runs.length === 0 && (
            <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No runs yet.</p>
          )}
          {runs.map((r) => (
            <div
              key={r.id}
              className={cn(
                'group rounded-md px-2 py-1.5',
                currentRunId === r.id ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <div className="flex items-center gap-2">
                <StatusDot
                  status={RUN_DOT[r.status] ?? 'idle'}
                  pulse={r.status === 'running'}
                  glow={r.live && r.status === 'running'}
                />
                <button onClick={() => void openRun(r.id)} className="flex-1 truncate text-left text-[13px]">
                  {r.summary || 'Run'}
                </button>
                {r.resumable && (
                  <button
                    onClick={() => void resumeRun(r.id)}
                    title="Resume run"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-run group-hover:opacity-100"
                  >
                    <Play className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="mt-0.5 pl-4 text-[10px] text-muted-foreground">
                {r.status}
                {r.live ? ' · live' : ''} · {r.mode}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <Cockpit />
      </div>
    </div>
  );
}
