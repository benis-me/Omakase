import { useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { FileCog, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';
import { ScriptList } from './ScriptList';
import { DevTerminal } from './DevTerminal';
import { GitBadge } from './GitBadge';
import { OpenWithMenu } from './OpenWithMenu';
import { EnvEditor } from './EnvEditor';

export function DevWorkbench() {
  const activePath = useAppStore((s) => s.active?.path);
  const scanDev = useAppStore((s) => s.scanDev);
  const [envOpen, setEnvOpen] = useState(false);

  useEffect(() => {
    void scanDev();
  }, [activePath, scanDev]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
        <h2 className="text-[13px] font-medium">Dev</h2>
        <GitBadge />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => setEnvOpen(true)}
          >
            <FileCog className="size-3.5" />
            Env
          </Button>
          <OpenWithMenu />
          <Tooltip content="Rescan scripts">
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
