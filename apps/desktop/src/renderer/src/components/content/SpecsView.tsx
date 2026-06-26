import { useEffect, useState } from 'react';
import { Eye, Pencil, Trash2 } from 'lucide-react';
import type { SpecDoc, SpecPhase, SpecStatus } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { CodeEditor } from '../ui/code-editor';
import { MarkdownPreview } from '../ui/markdown-preview';
import { Tooltip } from '../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ContentLayout, EmptyDetail } from './ContentLayout';

const PHASES: SpecPhase[] = ['idea', 'spec', 'acceptance', 'test-plan', 'tasks', 'done'];
const STATUSES: SpecStatus[] = ['draft', 'ready', 'running', 'done', 'archived'];

export function SpecsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpecDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  useEffect(() => {
    void window.omakase.specs.list().then((list) => {
      setSpecs(list);
      setSelectedId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)));
    });
  }, [activePath]);

  useEffect(() => {
    const spec = specs.find((s) => s.id === selectedId) ?? null;
    setDraft(spec ? { ...spec } : null);
    setDirty(false);
  }, [selectedId, specs]);

  const create = async (): Promise<void> => {
    const doc = await window.omakase.specs.create('Untitled spec');
    if (doc) {
      setSpecs((p) => [doc, ...p]);
      setSelectedId(doc.id);
    }
  };
  const save = async (): Promise<void> => {
    if (!draft) return;
    await window.omakase.specs.save(draft);
    setDirty(false);
    setSpecs((p) => p.map((s) => (s.id === draft.id ? draft : s)));
  };
  const remove = async (id: string): Promise<void> => {
    await window.omakase.specs.delete(id);
    setSpecs((p) => p.filter((s) => s.id !== id));
    if (selectedId === id) setSelectedId(null);
  };
  const update = (patch: Partial<SpecDoc>): void => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  };

  return (
    <ContentLayout title="Specs" onNew={() => void create()} newLabel="New spec">
      <div className="w-64 shrink-0 overflow-y-auto border-r p-2">
        {specs.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            No specs yet.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {specs.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  'block w-full rounded-md px-2.5 py-2 text-left transition-colors',
                  selectedId === s.id ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <div className="truncate text-[13px]">{s.title}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  <Badge variant="outline">{s.phase}</Badge>
                  <Badge variant={s.status === 'running' ? 'run' : 'default'}>{s.status}</Badge>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b p-3">
            <Input
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              className="h-9 flex-1 border-transparent bg-transparent px-2 text-[15px] font-semibold shadow-none focus-visible:border-input"
            />
            <Select value={draft.phase} onValueChange={(v) => update({ phase: v as SpecPhase })}>
              <SelectTrigger size="sm" className="w-32 capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PHASES.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={draft.status} onValueChange={(v) => update({ status: v as SpecStatus })}>
              <SelectTrigger size="sm" className="w-28 capitalize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((p) => (
                  <SelectItem key={p} value={p} className="capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center rounded-md border p-0.5">
              {(['edit', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-[12px] capitalize transition-colors',
                    mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'edit' ? <Pencil className="size-3" /> : <Eye className="size-3" />}
                  {m}
                </button>
              ))}
            </div>
            <Button variant={dirty ? 'omk' : 'outline'} size="sm" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
            <Tooltip content="Delete spec">
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void remove(draft.id)}
              >
                <Trash2 />
              </Button>
            </Tooltip>
          </div>
          {mode === 'edit' ? (
            <CodeEditor
              language="markdown"
              value={draft.body}
              onChange={(body) => update({ body })}
              className="min-h-0 flex-1 px-2 py-1"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {draft.body.trim() ? (
                <MarkdownPreview source={draft.body} />
              ) : (
                <p className="text-[12px] text-muted-foreground">Nothing to preview yet.</p>
              )}
            </div>
          )}
        </div>
      ) : (
        <EmptyDetail message="Select a spec from the list, or create a new one to start capturing requirements." />
      )}
    </ContentLayout>
  );
}
