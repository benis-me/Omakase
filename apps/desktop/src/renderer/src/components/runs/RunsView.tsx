import { useEffect, useState } from 'react';
import { Play, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { StatusDot } from '../StatusDot';
import { Cockpit } from './Cockpit';
import { RUN_DOT, effectiveStatus } from './run-status';

export function RunsView() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const runs = useAppStore((s) => s.runs);
  const currentRunId = useAppStore((s) => s.currentRunId);
  const loadRuns = useAppStore((s) => s.loadRuns);
  const openRun = useAppStore((s) => s.openRun);
  const closeRun = useAppStore((s) => s.closeRun);
  const resumeRun = useAppStore((s) => s.resumeRun);
  const [armed, setArmed] = useState(0);

  useEffect(() => {
    void loadRuns();
    void window.omakase.triggers.list().then((ts) => setArmed(ts.filter((tr) => tr.enabled).length));
  }, [activePath, loadRuns, runs.length]);

  const liveCount = runs.filter((r) => r.live).length;

  return (
    <div className="flex h-full">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <h2 className="text-[13px] font-medium">{t('Runs')}</h2>
          <Button variant="omk" size="sm" className="ml-auto gap-1.5" onClick={closeRun}>
            <Plus className="size-3.5" />
            {t('New')}
          </Button>
        </div>
        {/* Fleet at a glance. */}
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          {liveCount > 0 ? <span className="text-run">{liveCount} {t('live')}</span> : <span>{t('idle')}</span>}
          <span>·</span>
          <span>{runs.length} {t('total')}</span>
          {armed > 0 && (
            <>
              <span>·</span>
              <span className="text-omk">{armed} {t('armed')}</span>
            </>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
              {t('No runs yet. Start one with “New”.')}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {runs.map((r) => (
                <div
                  key={r.id}
                  onClick={() => void openRun(r.id)}
                  className={cn(
                    'group cursor-pointer rounded-md px-2.5 py-2 transition-colors',
                    currentRunId === r.id ? 'bg-accent' : 'hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot
                      status={RUN_DOT[effectiveStatus(r.status, r.live)] ?? 'idle'}
                      pulse={r.live && r.status === 'running'}
                      glow={r.live && r.status === 'running'}
                    />
                    <span className="flex-1 truncate text-[13px]">{r.summary || t('Run')}</span>
                    {r.resumable && (
                      <Tooltip content={t('Resume run')}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void resumeRun(r.id);
                          }}
                          className="text-muted-foreground opacity-0 outline-none transition-opacity hover:text-run group-hover:opacity-100"
                        >
                          <Play className="size-3.5" />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 pl-4 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>{effectiveStatus(r.status, r.live)}</span>
                    {r.live && <span className="text-run">live</span>}
                    <span>·</span>
                    <span>{r.mode}</span>
                    {r.triggeredBy && (
                      <>
                        <span>·</span>
                        <span className="text-omk" title={`${t('Automation:')} ${r.triggeredBy}`}>
                          {t('auto')}
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
      <div className="min-h-0 min-w-0 flex-1">
        <Cockpit />
      </div>
    </div>
  );
}
