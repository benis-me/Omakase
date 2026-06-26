import { useEffect, useState } from 'react';
import { ChevronDown, Play, Plus, Trash2 } from 'lucide-react';
import type { WorkflowDoc, WorkflowTemplateDto } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code-editor';
import { Tooltip } from '../ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { ContentLayout, EmptyDetail } from './ContentLayout';

/** Inline reference for the workflow host API, surfaced above the editor. */
const WORKFLOW_API: { sig: string; desc: string }[] = [
  { sig: 'w.phase(name, fn)', desc: 'Group work into a named, tracked phase.' },
  { sig: 'w.agent({ role, title, prompt })', desc: 'Run a sub-agent → { text, status }.' },
  { sig: 'w.parallel([fns])', desc: 'Run tasks concurrently, await all (barrier).' },
  { sig: 'w.pipeline(items, ...stages)', desc: 'Each item flows through every stage independently — no barrier.' },
  { sig: 'w.loopUntil(fn, { maxRounds })', desc: 'Bounded loop-until-dry / until-condition.' },
  { sig: 'w.budget()', desc: 'Remaining sub-agent allowance → { total, spent, remaining }.' },
  { sig: 'w.requestReport({ title, reason, summary })', desc: 'Emit a report into the run.' },
  { sig: 'w.updateWiki({ kind, title, body })', desc: 'Record knowledge to the project wiki.' },
  { sig: 'w.log(msg)', desc: 'Emit a progress note.' },
];

function ApiCheatsheet() {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">API</span>
      {WORKFLOW_API.map((m) => (
        <Tooltip key={m.sig} content={m.desc}>
          <code className="cursor-default rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 hover:text-foreground">
            {m.sig}
          </code>
        </Tooltip>
      ))}
    </div>
  );
}

export function WorkflowsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const startWorkflow = useAppStore((s) => s.startWorkflow);
  const [workflows, setWorkflows] = useState<WorkflowDoc[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplateDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void window.omakase.workflows.list().then((list) => {
      setWorkflows(list);
      setSelectedId((c) => (c && list.some((w) => w.id === c) ? c : (list[0]?.id ?? null)));
    });
    void window.omakase.workflows.templates().then(setTemplates);
  }, [activePath]);

  useEffect(() => {
    setSource(workflows.find((w) => w.id === selectedId)?.source ?? '');
    setDirty(false);
  }, [selectedId, workflows]);

  const createFrom = async (template: WorkflowTemplateDto): Promise<void> => {
    const wf = await window.omakase.workflows.create(template.name, template.id);
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

  const newMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="omk" size="sm" className="gap-1.5">
          <Plus className="size-3.5" />
          New
          <ChevronDown className="size-3 opacity-80" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="uppercase tracking-wide">From a template</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {templates.map((t) => (
          <DropdownMenuItem
            key={t.id}
            onSelect={() => void createFrom(t)}
            className="flex-col items-start gap-0.5 py-2"
          >
            <span className="text-[13px] font-medium text-foreground">{t.name}</span>
            <span className="text-[11px] leading-snug text-muted-foreground">{t.description}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <ContentLayout title="Workflows" actions={newMenu}>
      <div className="w-60 shrink-0 overflow-y-auto border-r p-2">
        {workflows.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            No workflows yet. Start from a template with “New”.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workflows.map((w) => (
              <button
                key={w.id}
                onClick={() => setSelectedId(w.id)}
                className={cn(
                  'block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  selectedId === w.id ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-11 items-center gap-2 border-b px-4">
            <span className="font-mono text-[12px] text-muted-foreground">workflows/{selected.id}.ts</span>
            <Tooltip content="Run this workflow (requires Bun)">
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto gap-1.5 text-muted-foreground hover:text-run"
                onClick={() => void startWorkflow(selected.id)}
              >
                <Play className="size-3.5" />
                Run
              </Button>
            </Tooltip>
            <Button variant={dirty ? 'omk' : 'outline'} size="sm" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
            <Tooltip content="Delete workflow">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove(selected.id)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          </div>
          <ApiCheatsheet />
          <CodeEditor
            language="typescript"
            value={source}
            onChange={(v) => {
              setSource(v);
              setDirty(true);
            }}
            className="min-h-0 flex-1 px-2 py-1"
          />
        </div>
      ) : (
        <EmptyDetail message="Select a workflow script, or start one from a template to orchestrate multi-agent runs." />
      )}
    </ContentLayout>
  );
}
