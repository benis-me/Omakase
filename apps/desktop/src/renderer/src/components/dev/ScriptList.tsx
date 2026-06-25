import { ExternalLink, Play, RotateCw, Square } from 'lucide-react';
import type { ScriptStatus } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { StatusDot, type DotStatus } from '../StatusDot';

const DOT: Record<ScriptStatus, DotStatus> = {
  idle: 'idle',
  starting: 'warn',
  running: 'run',
  exited: 'idle',
  errored: 'fail',
};

export function ScriptList() {
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
        No runnable scripts found in this workspace.
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
              <span className="rounded bg-muted px-1 text-[10px] font-normal normal-case text-muted-foreground">
                {project.type}
              </span>
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
                  'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5',
                  isSelected ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <StatusDot status={DOT[status]} pulse={running} glow={status === 'running'} />
                <span className="flex-1 truncate font-mono text-[12px]">{script.name}</span>
                {session?.url && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void window.omakase.shell.openExternal(session.url!);
                    }}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                    title={session.url}
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                )}
                {running ? (
                  <>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void restartScript(script.id);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      title="Restart"
                    >
                      <RotateCw className="size-3.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void stopScript(script.id);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      title="Stop"
                    >
                      <Square className="size-3.5" />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void startScript(script.id);
                    }}
                    className="text-muted-foreground hover:text-run"
                    title="Start"
                  >
                    <Play className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
