import { useCallback, useEffect, useState } from 'react';
import { Clock, Eye, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import type { SaveTriggerInput, SpecDoc, TriggerDto } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Switch } from '../ui/switch';
import { Tooltip } from '../ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { StatusDot } from '../StatusDot';

function toInput(t: TriggerDto): SaveTriggerInput {
  return {
    id: t.id,
    name: t.name,
    enabled: t.enabled,
    kind: t.kind,
    specId: t.specId,
    prompt: t.prompt,
    mode: t.mode,
    autonomy: t.autonomy,
    agentId: t.agentId,
    maxTokens: t.maxTokens,
    intervalMinutes: t.intervalMinutes,
    debounceMs: t.debounceMs,
  };
}

function ago(at?: number): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function AutomationsView() {
  const t = useT();
  const activePath = useAppStore((s) => s.active?.path);
  const contentTick = useAppStore((s) => s.contentTick);
  const [triggers, setTriggers] = useState<TriggerDto[]>([]);
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [clis, setClis] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<SaveTriggerInput | null>(null);

  const reload = useCallback(() => {
    void window.omakase.triggers.list().then(setTriggers);
  }, []);

  useEffect(() => {
    reload();
    void window.omakase.specs.list().then(setSpecs);
    void window.omakase.agents
      .detect()
      .then((l) => setClis(l.filter((d) => d.available).map((d) => ({ id: d.id, name: d.name }))));
  }, [activePath, reload, contentTick]);

  const toggle = async (t: TriggerDto): Promise<void> => {
    await window.omakase.triggers.save({ ...toInput(t), enabled: !t.enabled });
    reload();
  };
  const remove = async (id: string): Promise<void> => {
    await window.omakase.triggers.delete(id);
    reload();
  };
  const save = async (input: SaveTriggerInput): Promise<void> => {
    await window.omakase.triggers.save(input);
    setEditing(null);
    reload();
  };

  const specTitle = (id?: string): string => specs.find((s) => s.id === id)?.title ?? id ?? '';

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="text-[13px] font-medium">{t('Automations')}</h2>
        <Button
          variant="omk"
          size="sm"
          className="ml-auto gap-1.5"
          onClick={() =>
            setEditing({ name: '', kind: 'interval', mode: 'normal', autonomy: 'medium', intervalMinutes: 30 })
          }
        >
          <Plus className="size-3.5" />
          {t('New automation')}
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {triggers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="grid size-14 place-items-center rounded-2xl bg-omk/12 text-omk ring-1 ring-omk/20">
              <Zap className="size-7" />
            </div>
            <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
              {t(
                'No automations yet. Create a trigger to start a run on a schedule or whenever files change — the basis for unattended, self-iterating loops.',
              )}
            </p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-2">
            {triggers.map((tr) => (
              <div key={tr.id} className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3">
                <StatusDot status={tr.enabled ? 'run' : 'idle'} pulse={tr.enabled} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{tr.name || t('Automation')}</span>
                    <Badge variant="outline" className="gap-1 normal-case">
                      {tr.kind === 'watch' ? <Eye className="size-3" /> : <Clock className="size-3" />}
                      {tr.kind === 'interval'
                        ? `${t('every')} ${tr.intervalMinutes ?? 30}m`
                        : tr.kind === 'daily'
                          ? `${t('daily')} ${tr.dailyTime ?? '02:00'}`
                          : t('on changes')}
                    </Badge>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {tr.specId ? `${t('spec:')} ${specTitle(tr.specId)}` : tr.prompt ? `${t('task:')} ${tr.prompt}` : t('no source')} ·{' '}
                    {tr.mode} · {t('autonomy')} {tr.autonomy}
                    {tr.agentId ? ` · ${tr.agentId}` : ''} · {t('fired')} {ago(tr.lastFiredAt)}
                  </div>
                </div>
                <Tooltip content={tr.enabled ? t('Enabled') : t('Disabled')}>
                  <span className="inline-flex">
                    <Switch checked={tr.enabled} onCheckedChange={() => void toggle(tr)} />
                  </span>
                </Tooltip>
                <Tooltip content={t('Edit')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setEditing(toInput(tr))}
                  >
                    <Pencil />
                  </Button>
                </Tooltip>
                <Tooltip content={t('Delete')}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(tr.id)}
                  >
                    <Trash2 />
                  </Button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      <TriggerDialog
        value={editing}
        specs={specs}
        clis={clis}
        onCancel={() => setEditing(null)}
        onSave={(v) => void save(v)}
      />
    </div>
  );
}

function TriggerDialog({
  value,
  specs,
  clis,
  onCancel,
  onSave,
}: {
  value: SaveTriggerInput | null;
  specs: SpecDoc[];
  clis: { id: string; name: string }[];
  onCancel: () => void;
  onSave: (v: SaveTriggerInput) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<SaveTriggerInput>(value ?? { name: '', kind: 'interval' });
  useEffect(() => {
    if (value) setDraft(value);
  }, [value]);

  const set = (patch: Partial<SaveTriggerInput>): void => setDraft((d) => ({ ...d, ...patch }));
  const source: 'spec' | 'prompt' =
    draft.specId !== undefined ? 'spec' : draft.prompt !== undefined ? 'prompt' : 'spec';
  const canSave = draft.name.trim().length > 0 && Boolean(draft.specId || draft.prompt?.trim());

  return (
    <Dialog open={value !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg gap-4">
        <DialogHeader>
          <DialogTitle>{draft.id ? t('Edit automation') : t('New automation')}</DialogTitle>
          <DialogDescription>
            {t('A trigger starts a run automatically — on a schedule or when files change.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="trig-name">{t('Name')}</Label>
            <Input
              id="trig-name"
              autoFocus
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={t('Nightly spec run')}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('Source')}</Label>
            <div className="flex gap-2">
              <Select
                value={source}
                onValueChange={(v) =>
                  v === 'spec' ? set({ prompt: undefined, specId: specs[0]?.id }) : set({ specId: undefined, prompt: '' })
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="spec">{t('From a spec')}</SelectItem>
                  <SelectItem value="prompt">{t('A task')}</SelectItem>
                </SelectContent>
              </Select>
              {source === 'spec' ? (
                <Select value={draft.specId ?? ''} onValueChange={(v) => set({ specId: v })}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder={t('Choose a spec…')} />
                  </SelectTrigger>
                  <SelectContent>
                    {specs.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  className="flex-1"
                  value={draft.prompt ?? ''}
                  onChange={(e) => set({ prompt: e.target.value })}
                  placeholder={t('Describe the task…')}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('Trigger')}</Label>
              <Select value={draft.kind} onValueChange={(v) => set({ kind: v as SaveTriggerInput['kind'] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="interval">{t('Every N minutes')}</SelectItem>
                  <SelectItem value="daily">{t('Daily at a time')}</SelectItem>
                  <SelectItem value="watch">{t('On file changes')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {draft.kind === 'interval' ? (
              <div className="space-y-1.5">
                <Label htmlFor="trig-interval">{t('Every (minutes)')}</Label>
                <Input
                  id="trig-interval"
                  type="number"
                  min={1}
                  value={draft.intervalMinutes ?? 30}
                  onChange={(e) => set({ intervalMinutes: Math.max(1, Number(e.target.value) || 30) })}
                />
              </div>
            ) : draft.kind === 'daily' ? (
              <div className="space-y-1.5">
                <Label htmlFor="trig-time">{t('At (local time)')}</Label>
                <Input
                  id="trig-time"
                  type="time"
                  value={draft.dailyTime ?? '02:00'}
                  onChange={(e) => set({ dailyTime: e.target.value })}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="trig-debounce">{t('Debounce (ms)')}</Label>
                <Input
                  id="trig-debounce"
                  type="number"
                  min={500}
                  value={draft.debounceMs ?? 5000}
                  onChange={(e) => set({ debounceMs: Math.max(500, Number(e.target.value) || 5000) })}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>{t('Mode')}</Label>
              <Select value={draft.mode ?? 'normal'} onValueChange={(v) => set({ mode: v as 'normal' | 'max-power' })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">normal</SelectItem>
                  <SelectItem value="max-power">max-power</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('Autonomy')}</Label>
              <Select
                value={draft.autonomy ?? 'medium'}
                onValueChange={(v) => set({ autonomy: v as SaveTriggerInput['autonomy'] })}
              >
                <SelectTrigger className="w-full capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['off', 'low', 'medium', 'high'] as const).map((a) => (
                    <SelectItem key={a} value={a} className="capitalize">
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('Agent CLI')}</Label>
              <Select value={draft.agentId ?? 'auto'} onValueChange={(v) => set({ agentId: v === 'auto' ? undefined : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  {clis.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="trig-budget">{t('Token budget per run (optional)')}</Label>
            <Input
              id="trig-budget"
              type="number"
              min={0}
              value={draft.maxTokens ?? ''}
              onChange={(e) => set({ maxTokens: Number(e.target.value) || undefined })}
              placeholder={t('∞ — no cap')}
            />
          </div>

          <label className="flex items-center gap-2.5 pt-1">
            <Switch checked={draft.enabled ?? false} onCheckedChange={(v) => set({ enabled: v })} />
            <span className="text-[13px]">{t('Enabled — arm this trigger now')}</span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button variant="omk" size="sm" disabled={!canSave} onClick={() => onSave(draft)}>
            {t('Save automation')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
