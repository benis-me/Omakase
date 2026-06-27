import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileCog, Play, RefreshCw, Square } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { ScriptList } from './ScriptList';
import { DevTerminal } from './DevTerminal';
import { GitBadge } from './GitBadge';
import { OpenWithMenu } from './OpenWithMenu';
import { EnvEditor } from './EnvEditor';

export function DevWorkbench() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const scanDev = useAppStore((s) => s.scanDev);
  const startAllScripts = useAppStore((s) => s.startAllScripts);
  const stopAllScripts = useAppStore((s) => s.stopAllScripts);
  const sessions = useAppStore((s) => s.sessions);
  const [envOpen, setEnvOpen] = useState(false);

  const liveCount = Object.values(sessions).filter(
    (s) => s.status === 'running' || s.status === 'starting',
  ).length;

  useEffect(() => {
    void scanDev();
  }, [activePath, scanDev]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="text-[13px] font-medium">{t('Dev')}</h2>
        <GitBadge />
        <div className="ml-auto flex items-center gap-1">
          <Tooltip content={t('Start all services')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-run"
              onClick={() => void startAllScripts()}
            >
              <Play className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={t('Stop all')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive disabled:opacity-40"
              disabled={liveCount === 0}
              onClick={() => void stopAllScripts()}
            >
              <Square className="size-3.5" />
            </Button>
          </Tooltip>
          <div className="mx-1 h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setEnvOpen(true)}
          >
            <FileCog className="size-3.5" />
            {t('Env')}
          </Button>
          <OpenWithMenu />
          <Tooltip content={t('Rescan scripts')}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => void scanDev()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </Tooltip>
        </div>
      </header>
      <PanelGroup direction="horizontal" className="min-h-0 flex-1">
        <Panel defaultSize={40} minSize={24} className="min-w-0">
          <ScriptList />
        </Panel>
        <PanelResizeHandle className="resize-handle" />
        <Panel minSize={30} className="min-w-0">
          <DevTerminal />
        </Panel>
      </PanelGroup>
      <EnvEditor open={envOpen} onOpenChange={setEnvOpen} />
    </div>
  );
}
