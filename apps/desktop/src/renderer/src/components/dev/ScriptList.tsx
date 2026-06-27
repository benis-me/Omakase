import { ExternalLink, Play, RotateCw, Square } from 'lucide-react';
import type { ScriptStatus } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Tooltip } from '../ui/tooltip';
import { StatusDot, type DotStatus } from '../StatusDot';

const DOT: Record<ScriptStatus, DotStatus> = {
  idle: 'idle',
  starting: 'warn',
  running: 'run',
  exited: 'idle',
  errored: 'fail',
};

export function ScriptList() {
  const t = useT();
  const projects = useAppStore((s) => s.projects);
  const sessions = useAppStore((s) => s.sessions);
  const selected = useAppStore((s) => s.selectedTerminal);
  const startScript = useAppStore((s) => s.startScript);
  const stopScript = useAppStore((s) => s.stopScript);
  const restartScript = useAppStore((s) => s.restartScript);
  const selectTerminal = useAppStore((s) => s.selectTerminal);

  if (projects.length === 0) {
    return (
      <div className="grid h-full place-items-center p-8 text-center text-[12px] leading-relaxed text-muted-foreground">
        {t('No runnable scripts found in this workspace.')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      {projects.map((project) => (
        <div key={project.path} className="mb-3">
          <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span className="truncate">{project.rel === '.' ? project.name : project.rel}</span>
            {project.type && (
              <Badge variant="outline" className="normal-case">
                {project.type}
              </Badge>
            )}
          </div>
          {project.scripts.map((script) => {
            const session = sessions[script.id];
            const status: ScriptStatus = session?.status ?? 'idle';
            const running = status === 'running' || status === 'starting';
            const isSelected = selected === script.id;
            return (
              <div
                key={script.id}
                onClick={() => selectTerminal(script.id)}
                className={cn(
                  'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 transition-colors',
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <StatusDot status={DOT[status]} pulse={running} glow={status === 'running'} />
                <span className="flex-1 truncate font-mono text-[12px]">{script.name}</span>
                {session?.url && (
                  <Tooltip content={session.url}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        void window.omakase.shell.openExternal(session.url!);
                      }}
                    >
                      <ExternalLink />
                    </Button>
                  </Tooltip>
                )}
                {running ? (
                  <>
                    <Tooltip content={t('Restart')}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          void restartScript(script.id);
                        }}
                      >
                        <RotateCw />
                      </Button>
                    </Tooltip>
                    <Tooltip content={t('Stop')}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          void stopScript(script.id);
                        }}
                      >
                        <Square />
                      </Button>
                    </Tooltip>
                  </>
                ) : (
                  <Tooltip content={t('Start')}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-6 text-muted-foreground hover:text-run"
                      onClick={(e) => {
                        e.stopPropagation();
                        void startScript(script.id);
                      }}
                    >
                      <Play />
                    </Button>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
