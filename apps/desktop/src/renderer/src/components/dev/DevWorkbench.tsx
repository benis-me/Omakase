import { useEffect } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { RefreshCw } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { ScriptList } from './ScriptList';
import { DevTerminal } from './DevTerminal';

export function DevWorkbench() {
  const activePath = useAppStore((s) => s.active?.path);
  const scanDev = useAppStore((s) => s.scanDev);

  useEffect(() => {
    void scanDev();
  }, [activePath, scanDev]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-[13px] font-medium">Dev</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto text-muted-foreground hover:text-foreground"
          title="Rescan scripts"
          onClick={() => void scanDev()}
        >
          <RefreshCw className="size-3.5" />
        </Button>
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
    </div>
  );
}
