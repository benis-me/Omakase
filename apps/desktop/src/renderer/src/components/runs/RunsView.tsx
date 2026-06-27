import { useEffect } from 'react';
import { Play, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusDot } from '../StatusDot';
import { Cockpit } from './Cockpit';
import { RUN_DOT } from './run-status';

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
          <Button variant="omk" size="sm" className="ml-auto gap-1.5" onClick={closeRun}>
            <Plus className="size-3.5" />
            New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
              No runs yet. Start one with “New”.
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {runs.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    'group rounded-md px-2.5 py-2 transition-colors',
                    currentRunId === r.id ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={RUN_DOT[r.status] ?? 'idle'}
                      pulse={r.status === 'running'}
                      glow={r.live && r.status === 'running'}
                    />
                    <button
                      onClick={() => void openRun(r.id)}
                      className="flex-1 truncate text-left text-[13px] outline-none"
                    >
                      {r.summary || 'Run'}
                    </button>
                    {r.resumable && (
                      <Tooltip content="Resume run">
                        <button
                          onClick={() => void resumeRun(r.id)}
                          className="text-muted-foreground opacity-0 outline-none transition-opacity hover:text-run group-hover:opacity-100"
                        >
                          <Play className="size-3.5" />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-4 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>{r.status}</span>
                    {r.live && <span className="text-run">live</span>}
                    <span>·</span>
                    <span>{r.mode}</span>
                    {r.triggeredBy && (
                      <>
                        <span>·</span>
                        <span className="text-omk" title={`Automation: ${r.triggeredBy}`}>
                          auto
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <Cockpit />
      </div>
    </div>
  );
}
