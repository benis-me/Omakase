import { useAppStore } from '@/store/useAppStore';
import { RunsView } from './runs/RunsView';
import { DevWorkbench } from './dev/DevWorkbench';
import { SpecsView } from './content/SpecsView';
import { AgentsView } from './content/AgentsView';
import { AutomationsView } from './content/AutomationsView';
import { MemoryView } from './content/MemoryView';
import { WorkflowsView } from './content/WorkflowsView';

export function DetailPane() {
  const nav = useAppStore((s) => s.nav);
  switch (nav) {
    case 'runs':
      return <RunsView />;
    case 'specs':
      return <SpecsView />;
    case 'agents':
      return <AgentsView />;
    case 'automations':
      return <AutomationsView />;
    case 'memory':
      return <MemoryView />;
    case 'workflows':
      return <WorkflowsView />;
    case 'dev':
      return <DevWorkbench />;
    default:
      return null;
  }
}
