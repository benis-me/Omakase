import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, Check, CircleCheck, Eye, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { SpecDoc, SpecPhase, SpecStatus } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { CodeEditor } from '../ui/code-editor';
import { MarkdownPreview } from '../ui/markdown-preview';
import { Tooltip } from '../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ContentLayout, EmptyDetail } from './ContentLayout';

/** The ordered Spec phases (mirrors @omakase/core's SPEC_PHASES; kept local to the renderer bundle). */
const PHASES: SpecPhase[] = ['idea', 'spec', 'acceptance', 'test-plan', 'tasks', 'done'];
const STATUSES: SpecStatus[] = ['draft', 'ready', 'running', 'done', 'archived'];

/** Human labels + a one-line hint for each phase in the rail/editor. */
const PHASE_META: Record<SpecPhase, { label: string; blurb: string }> = {
  idea: { label: 'Idea', blurb: 'A one-line title for what you want to build.' },
  spec: { label: 'Spec', blurb: 'The markdown spec: summary, scope, and approach.' },
  acceptance: { label: 'Acceptance', blurb: 'Testable assertions that define done.' },
  'test-plan': { label: 'Test plan', blurb: 'How each criterion is verified.' },
  tasks: { label: 'Tasks', blurb: 'The implementation slices to execute.' },
  done: { label: 'Done', blurb: 'The spec is fully drafted and ready to run.' },
};

/** Which structured array a list-phase edits on the doc. */
const LIST_FIELD: Partial<Record<SpecPhase, 'acceptanceCriteria' | 'testPlan' | 'tasks'>> = {
  acceptance: 'acceptanceCriteria',
  'test-plan': 'testPlan',
  tasks: 'tasks',
};

/**
 * Mirror of @omakase/core's per-phase content guard, so the Advance button can be
 * disabled before the (authoritative) main-process check runs.
 */
function canAdvance(doc: SpecDoc): boolean {
  switch (doc.phase) {
    case 'idea':
      return doc.title.trim().length > 0;
    case 'spec':
      return doc.body.trim().length > 0;
    case 'acceptance':
      return doc.acceptanceCriteria.length > 0;
    case 'test-plan':
      return doc.testPlan.length > 0;
    case 'tasks':
      return doc.tasks.length > 0;
    case 'done':
      return false;
  }
}

export function SpecsView() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const contentTick = useAppStore((s) => s.contentTick);
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SpecDoc | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  /** Which phase's artifact the detail pane is showing; defaults to the live phase. */
  const [viewPhase, setViewPhase] = useState<SpecPhase>('idea');

  useEffect(() => {
    void window.omakase.specs.list().then((list) => {
      setSpecs(list);
      setSelectedId((cur) => (cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null)));
    });
  }, [activePath, contentTick]);

  useEffect(() => {
    const spec = specs.find((s) => s.id === selectedId) ?? null;
    setDraft(spec ? { ...spec } : null);
    setViewPhase(spec ? spec.phase : 'idea');
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

  /** Persist any unsaved edits, then advance the live phase through the core guard. */
  const advance = async (): Promise<void> => {
    if (!draft) return;
    if (dirty) await save();
    const next = await window.omakase.specs.advance(draft.id);
    if (!next) {
      toast.error(t("Add this phase's content before advancing."));
      return;
    }
    setDraft({ ...next });
    setDirty(false);
    setSpecs((p) => p.map((s) => (s.id === next.id ? next : s)));
    setViewPhase(next.phase);
  };

  return (
    <ContentLayout title="Specs" onNew={() => void create()} newLabel="New spec">
      <div className="w-64 shrink-0 overflow-y-auto border-r p-2">
        {specs.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-muted-foreground">
            {t('No specs yet.')}
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
        <SpecDetail
          draft={draft}
          dirty={dirty}
          mode={mode}
          viewPhase={viewPhase}
          onModeChange={setMode}
          onViewPhase={setViewPhase}
          onUpdate={update}
          onSave={() => void save()}
          onDelete={() => void remove(draft.id)}
          onAdvance={() => void advance()}
        />
      ) : (
        <EmptyDetail message="Select a spec from the list, or create a new one to start capturing requirements." />
      )}
    </ContentLayout>
  );
}

function SpecDetail({
  draft,
  dirty,
  mode,
  viewPhase,
  onModeChange,
  onViewPhase,
  onUpdate,
  onSave,
  onDelete,
  onAdvance,
}: {
  draft: SpecDoc;
  dirty: boolean;
  mode: 'edit' | 'preview';
  viewPhase: SpecPhase;
  onModeChange: (m: 'edit' | 'preview') => void;
  onViewPhase: (p: SpecPhase) => void;
  onUpdate: (patch: Partial<SpecDoc>) => void;
  onSave: () => void;
  onDelete: () => void;
  onAdvance: () => void;
}) {
  const t = useT();
  const currentIdx = PHASES.indexOf(draft.phase);
  const ready = canAdvance(draft);
  const advances = draft.history.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: spec name + status + save/delete */}
      <div className="flex items-center gap-2 border-b p-3">
        <Input
          value={draft.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          className="h-9 flex-1 border-transparent bg-transparent px-2 text-[15px] font-semibold shadow-none focus-visible:border-input"
        />
        <Select value={draft.status} onValueChange={(v) => onUpdate({ status: v as SpecStatus })}>
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
        <Button variant={dirty ? 'omk' : 'outline'} size="sm" disabled={!dirty} onClick={onSave}>
          {t('Save')}
        </Button>
        <Tooltip content={t('Delete spec')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </Tooltip>
      </div>

      {/* Phase rail: ordered stepper */}
      <div className="flex items-center gap-1 overflow-x-auto border-b px-3 py-2.5">
        {PHASES.map((phase, idx) => {
          const completed = idx < currentIdx;
          const isCurrent = idx === currentIdx;
          const isViewing = phase === viewPhase;
          return (
            <div key={phase} className="flex items-center">
              {idx > 0 && (
                <div className={cn('h-px w-4 shrink-0', idx <= currentIdx ? 'bg-omk/50' : 'bg-border')} />
              )}
              <Tooltip content={t(PHASE_META[phase].blurb)}>
                <button
                  onClick={() => onViewPhase(phase)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                    isViewing && 'ring-1 ring-ring',
                    isCurrent
                      ? 'border-omk/40 bg-omk/15 font-medium text-omk'
                      : completed
                        ? 'border-transparent bg-omk/10 text-omk/90 hover:bg-omk/15'
                        : 'border-transparent text-muted-foreground hover:bg-accent/60',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-full text-[10px] tabular-nums',
                      completed
                        ? 'bg-omk text-omk-foreground'
                        : isCurrent
                          ? 'border border-omk text-omk'
                          : 'border border-muted-foreground/40 text-muted-foreground',
                    )}
                  >
                    {completed ? <Check className="size-2.5" /> : idx + 1}
                  </span>
                  {t(PHASE_META[phase].label)}
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>

      {/* Current-artifact editor for the selected phase */}
      <PhaseEditor draft={draft} viewPhase={viewPhase} mode={mode} onModeChange={onModeChange} onUpdate={onUpdate} />

      {/* Footer: advance / done + history hint */}
      <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5">
        <span className="text-[11px] text-muted-foreground">
          {advances === 0 ? t('Not advanced yet') : `Advanced ${advances} time${advances === 1 ? '' : 's'}`}
        </span>
        {draft.phase === 'done' ? (
          <span className="flex items-center gap-1.5 text-[12px] font-medium text-omk">
            <CircleCheck className="size-4" />
            {t('Spec complete')}
          </span>
        ) : (
          <Tooltip
            content={
              ready
                ? `${t('Advance to')} ${t(PHASE_META[PHASES[currentIdx + 1]!].label)}`
                : `${t('Add')} ${t(PHASE_META[draft.phase].label).toLowerCase()} ${t('content to advance')}`
            }
          >
            <span>
              <Button variant="omk" size="sm" disabled={!ready} onClick={onAdvance}>
                {t('Advance')}
                <ArrowRight />
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Renders the editor appropriate to the viewed phase: title, markdown body, or list editor. */
function PhaseEditor({
  draft,
  viewPhase,
  mode,
  onModeChange,
  onUpdate,
}: {
  draft: SpecDoc;
  viewPhase: SpecPhase;
  mode: 'edit' | 'preview';
  onModeChange: (m: 'edit' | 'preview') => void;
  onUpdate: (patch: Partial<SpecDoc>) => void;
}) {
  const t = useT();
  const listField = LIST_FIELD[viewPhase];

  if (viewPhase === 'idea') {
    return (
      <PhaseFrame phase={viewPhase}>
        <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">{t('Title')}</label>
        <Input
          value={draft.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          placeholder={t('What are we building?')}
          className="text-[14px]"
        />
      </PhaseFrame>
    );
  }

  if (viewPhase === 'spec') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PhaseHeader phase={viewPhase}>
          <div className="flex items-center rounded-md border p-0.5">
            {(['edit', 'preview'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[12px] capitalize transition-colors',
                  mode === m ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {m === 'edit' ? <Pencil className="size-3" /> : <Eye className="size-3" />}
                {t(m)}
              </button>
            ))}
          </div>
        </PhaseHeader>
        {mode === 'edit' ? (
          <CodeEditor
            language="markdown"
            value={draft.body}
            onChange={(body) => onUpdate({ body })}
            className="min-h-0 flex-1 px-2 py-1"
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {draft.body.trim() ? (
              <MarkdownPreview source={draft.body} />
            ) : (
              <p className="text-[12px] text-muted-foreground">{t('Nothing to preview yet.')}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (viewPhase === 'done') {
    return (
      <PhaseFrame phase={viewPhase}>
        <div className="rounded-lg border border-dashed p-8 text-center">
          <CircleCheck className="mx-auto mb-2 size-7 text-omk" />
          <p className="text-[13px] font-medium">{t('This spec is fully drafted.')}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t('Idea, spec, acceptance criteria, test plan, and tasks are all captured.')}
          </p>
        </div>
      </PhaseFrame>
    );
  }

  // acceptance / test-plan / tasks — list editor
  const items = listField ? draft[listField] : [];
  const setItems = (next: string[]): void => {
    if (listField) onUpdate({ [listField]: next } as Partial<SpecDoc>);
  };
  return (
    <ListEditor phase={viewPhase} items={items} onChange={setItems} />
  );
}

function PhaseHeader({ phase, children }: { phase: SpecPhase; children?: ReactNode }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
      <div>
        <div className="text-[13px] font-medium capitalize">{t(PHASE_META[phase].label)}</div>
        <div className="text-[11px] text-muted-foreground">{t(PHASE_META[phase].blurb)}</div>
      </div>
      {children}
    </div>
  );
}

/** A non-scrolling phase body wrapper (header + padded content). */
function PhaseFrame({ phase, children }: { phase: SpecPhase; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PhaseHeader phase={phase} />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
    </div>
  );
}

/** Editable list of single-line items with add/remove, for the array-backed phases. */
function ListEditor({
  phase,
  items,
  onChange,
}: {
  phase: SpecPhase;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const t = useT();
  const addLabel = useMemo(() => {
    const labels: Partial<Record<SpecPhase, string>> = {
      acceptance: 'Add criterion',
      'test-plan': 'Add test',
      tasks: 'Add task',
    };
    return labels[phase] ?? 'Add item';
  }, [phase]);
  const setAt = (idx: number, value: string): void =>
    onChange(items.map((it, i) => (i === idx ? value : it)));
  const removeAt = (idx: number): void => onChange(items.filter((_, i) => i !== idx));
  const add = (): void => onChange([...items, '']);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PhaseHeader phase={phase} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {items.length === 0 ? (
          <p className="px-1 py-3 text-[12px] text-muted-foreground">
            {t('Nothing here yet — add at least one to advance.')}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                  {idx + 1}
                </span>
                <Input
                  value={item}
                  onChange={(e) => setAt(idx, e.target.value)}
                  placeholder="…"
                  className="flex-1"
                />
                <Tooltip content={t('Remove')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => removeAt(idx)}
                  >
                    <X />
                  </Button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" className="mt-3" onClick={add}>
          <Plus />
          {t(addLabel)}
        </Button>
      </div>
    </div>
  );
}
