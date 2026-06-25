import { useEffect, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import type { WorkflowDoc } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { ContentLayout, EmptyDetail } from './ContentLayout';

export function WorkflowsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const startWorkflow = useAppStore((s) => s.startWorkflow);
  const [workflows, setWorkflows] = useState<WorkflowDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.omakase.workflows.list().then((list) => {
      setWorkflows(list);
      setSelectedId((c) => (c && list.some((w) => w.id === c) ? c : (list[0]?.id ?? null)));
    });
  }, [activePath]);

  useEffect(() => {
    setSource(workflows.find((w) => w.id === selectedId)?.source ?? '');
    setDirty(false);
  }, [selectedId, workflows]);

  const create = async (): Promise<void> => {
    const wf = await window.omakase.workflows.create('New workflow');
    if (wf) {
      setWorkflows((p) => [...p, wf]);
      setSelectedId(wf.id);
    }
  };
  const save = async (): Promise<void> => {
    if (!selectedId) return;
    await window.omakase.workflows.save(selectedId, source);
    setDirty(false);
    setWorkflows((p) => p.map((w) => (w.id === selectedId ? { ...w, source } : w)));
  };
  const remove = async (id: string): Promise<void> => {
    await window.omakase.workflows.delete(id);
    setWorkflows((p) => p.filter((w) => w.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const selected = workflows.find((w) => w.id === selectedId);

  return (
    <ContentLayout title="Workflows" onNew={() => void create()} newLabel="New workflow">
      <div className="w-60 shrink-0 overflow-y-auto border-r p-1.5">
        {workflows.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No workflows yet.</p>
        )}
        {workflows.map((w) => (
          <button
            key={w.id}
            onClick={() => setSelectedId(w.id)}
            className={cn(
              'block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px]',
              selectedId === w.id ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            {w.name}
          </button>
        ))}
      </div>
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-4 py-2">
            <span className="font-mono text-[12px] text-muted-foreground">workflows/{selected.id}.ts</span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto gap-1.5 text-muted-foreground hover:text-run"
              title="Run this workflow (requires Bun)"
              onClick={() => void startWorkflow(selected.id)}
            >
              <Play className="size-3.5" />
              Run
            </Button>
            <Button variant={dirty ? 'omk' : 'ghost'} size="sm" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
            <button
              onClick={() => void remove(selected.id)}
              className="text-muted-foreground hover:text-destructive"
              title="Delete workflow"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <textarea
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-relaxed outline-none"
          />
        </div>
      ) : (
        <EmptyDetail message="Select or create a workflow script." />
      )}
    </ContentLayout>
  );
}
