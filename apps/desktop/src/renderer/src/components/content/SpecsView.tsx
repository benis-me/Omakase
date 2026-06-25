import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { SpecDoc, SpecPhase, SpecStatus } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { ContentLayout, EmptyDetail } from './ContentLayout';

const PHASES: SpecPhase[] = ['idea', 'spec', 'acceptance', 'test-plan', 'tasks', 'done'];
const STATUSES: SpecStatus[] = ['draft', 'ready', 'running', 'done', 'archived'];

export function SpecsView() {
  const activePath = useAppStore((s) => s.active?.path);
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpecDoc | null>(null);
  const [dirty, setDirty] = useState(false);

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
      <div className="w-64 shrink-0 overflow-y-auto border-r p-1.5">
        {specs.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-muted-foreground">No specs yet.</p>
        )}
        {specs.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            className={cn(
              'block w-full rounded-md px-2 py-1.5 text-left',
              selectedId === s.id ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <div className="truncate text-[13px]">{s.title}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="uppercase">{s.phase}</span>·<span>{s.status}</span>
            </div>
          </button>
        ))}
      </div>
      {draft ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b p-3">
            <input
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
              className="flex-1 bg-transparent text-[15px] font-semibold outline-none"
            />
            <select
              value={draft.phase}
              onChange={(e) => update({ phase: e.target.value as SpecPhase })}
              className="rounded border bg-background px-2 py-1 text-[12px]"
            >
              {PHASES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <select
              value={draft.status}
              onChange={(e) => update({ status: e.target.value as SpecStatus })}
              className="rounded border bg-background px-2 py-1 text-[12px]"
            >
              {STATUSES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <Button variant={dirty ? 'omk' : 'ghost'} size="sm" disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
            <button
              onClick={() => void remove(draft.id)}
              className="text-muted-foreground hover:text-destructive"
              title="Delete spec"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
          <textarea
            value={draft.body}
            onChange={(e) => update({ body: e.target.value })}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none"
          />
        </div>
      ) : (
        <EmptyDetail message="Select or create a spec." />
      )}
    </ContentLayout>
  );
}
