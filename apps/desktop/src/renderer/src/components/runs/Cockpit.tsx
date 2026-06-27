import { useEffect, useMemo, useState } from 'react';
import { Pause, Play, RotateCw, Send, Square, Trash2, X } from 'lucide-react';
import type { AutonomyLevel, CockpitEvent, RunMode, SpecDoc } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusDot } from '../StatusDot';
import { CockpitTabs } from './CockpitTabs';
import { PromptComposer } from './PromptComposer';
import { effectiveStatus, RUN_DOT } from './run-status';

function NewRunComposer() {
  const t = useT();
  const startRun = useAppStore((s) => s.startRun);
  const settings = useAppStore((s) => s.settings);
  const [prompt, setPrompt] = useState('');
  const [specId, setSpecId] = useState('none');
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [mode, setMode] = useState<RunMode>(settings?.defaultMode ?? 'normal');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(settings?.defaultAutonomy ?? 'low');
  const [agentId, setAgentId] = useState('auto');
  const [maxTokens, setMaxTokens] = useState('');
  const [clis, setClis] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    void window.omakase.specs.list().then(setSpecs);
    void window.omakase.agents
      .detect()
      .then((list) => setClis(list.filter((d) => d.available).map((d) => ({ id: d.id, name: d.name }))));
  }, []);

  const usingSpec = specId !== 'none';
  const canRun = usingSpec || prompt.trim().length > 0;
  const run = (): void => {
    if (!canRun) return;
    void startRun({
      ...(usingSpec ? { specId } : { prompt: prompt.trim() }),
      mode,
      autonomy,
      ...(agentId !== 'auto' ? { agentId } : {}),
      ...(Number(maxTokens) > 0 ? { maxTokens: Number(maxTokens) } : {}),
    });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-5 p-8">
      <div className="space-y-1.5">
        <h1 className="text-[19px] font-semibold tracking-tight">{t('Start a run')}</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('Hand a spec or a task to the loop. It plans, executes, verifies, and reports — you steer.')}
        </p>
      </div>

      {specs.length > 0 && (
        <div className="space-y-1.5">
          <Label>{t('From a spec')}</Label>
          <Select value={specId} onValueChange={setSpecId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t('None — write a task below')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('None — write a task below')}</SelectItem>
              {specs.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <PromptComposer
        onChange={setPrompt}
        placeholder={usingSpec ? t('Optional extra instructions…') : t('Describe the task…')}
      />

      <div className="flex items-center gap-2">
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t('CLI:')} auto</SelectItem>
            {clis.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {t('CLI:')} {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={mode} onValueChange={(v) => setMode(v as RunMode)}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="normal">normal</SelectItem>
            <SelectItem value="max-power">max-power</SelectItem>
          </SelectContent>
        </Select>
        <Select value={autonomy} onValueChange={(v) => setAutonomy(v as AutonomyLevel)}>
          <SelectTrigger size="sm" className="w-40 capitalize">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['off', 'low', 'medium', 'high'] as AutonomyLevel[]).map((a) => (
              <SelectItem key={a} value={a} className="capitalize">
                {t('autonomy:')} {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          min={0}
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
          placeholder={t('∞ tokens')}
          className="h-7 w-28 text-[12px]"
          title={t('Token budget — the run stops once spent')}
        />
        <Button variant="omk" className="ml-auto" disabled={!canRun} onClick={run}>
          <Play />
          {t('Run')}
        </Button>
      </div>
    </div>
  );
}

function GateDialog({ gate, onAnswer }: { gate: CockpitEvent | null; onAnswer: (answer: string) => void }) {
  const t = useT();
  const [text, setText] = useState('');
  useEffect(() => setText(''), [gate?.gateId]);

  return (
    <Dialog open={Boolean(gate)}>
      <DialogContent
        hideClose
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        className="max-w-md gap-4"
      >
        <DialogHeader>
          <DialogTitle>{t('The run needs your decision')}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-foreground">
            {gate?.detail}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('Optional guidance…')}
          rows={3}
          className="resize-none"
        />
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAnswer(text.trim() || 'Hold — keep iterating, do not proceed yet.')}
          >
            {t('Hold')}
          </Button>
          <Button
            variant="omk"
            size="sm"
            onClick={() => onAnswer(text.trim() ? `Proceed. ${text.trim()}` : 'Proceed.')}
          >
            {t('Approve & proceed')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LiveCockpit({ runId }: { runId: string }) {
  const t = useT();
  const feed = useAppStore((s) => s.feed);
  const acceptance = useAppStore((s) => s.acceptance);
  const runs = useAppStore((s) => s.runs);
  const controlRun = useAppStore((s) => s.controlRun);
  const closeRun = useAppStore((s) => s.closeRun);
  const deleteRun = useAppStore((s) => s.deleteRun);
  const resumeRun = useAppStore((s) => s.resumeRun);
  const retryRun = useAppStore((s) => s.retryRun);
  const [steer, setSteer] = useState('');

  const summary = runs.find((r) => r.id === runId);
  const status = summary?.status ?? 'running';
  // "Live" is the actual in-process flag — NOT whether the status is non-terminal.
  // After a restart a record still says `running`, but nothing is running.
  const live = summary?.live ?? false;
  const resumable = summary?.resumable ?? false;
  const displayStatus = effectiveStatus(status, live);

  const openGate = useMemo(() => {
    const answered = new Set(
      feed.filter((e) => e.kind === 'gate-answered' && e.gateId).map((e) => e.gateId),
    );
    for (let i = feed.length - 1; i >= 0; i -= 1) {
      const e = feed[i];
      if (e.kind === 'gate' && e.gateId && !answered.has(e.gateId)) return e;
    }
    return null;
  }, [feed]);

  const sendSteer = (): void => {
    if (steer.trim()) {
      void controlRun({ command: 'input', text: steer.trim() });
      setSteer('');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <StatusDot status={RUN_DOT[displayStatus] ?? 'idle'} pulse={live && status === 'running'} glow={live && status === 'running'} />
        <span className="text-[13px] font-medium capitalize">{displayStatus.replace(/-/g, ' ')}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{summary?.summary}</span>
        {summary && (summary.spentTokens ?? 0) > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">{summary.spentTokens} tok</span>
        )}
        <Tooltip content={t('Delete run')}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void deleteRun(runId)}
          >
            <Trash2 />
          </Button>
        </Tooltip>
        <Tooltip content={t('Close')}>
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={closeRun}>
            <X />
          </Button>
        </Tooltip>
      </header>

      <CockpitTabs feed={feed} acceptance={acceptance} />

      <div className="shrink-0 border-t bg-card/40 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendSteer();
            }}
            disabled={!live}
            placeholder={
              live
                ? t('Queue a steering message…')
                : resumable
                  ? t('This run was interrupted — resume to continue.')
                  : t('This run has ended.')
            }
          />
          <Tooltip content={t('Queue message')}>
            <Button variant="ghost" size="icon" disabled={!live || !steer.trim()} onClick={sendSteer}>
              <Send />
            </Button>
          </Tooltip>
          {live && status === 'running' && (
            <Tooltip content={t('Pause')}>
              <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'pause' })}>
                <Pause />
              </Button>
            </Tooltip>
          )}
          {live && status === 'paused' && (
            <Tooltip content={t('Resume')}>
              <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'resume' })}>
                <Play />
              </Button>
            </Tooltip>
          )}
          {live && (
            <Tooltip content={t('Stop')}>
              <Button
                variant="ghost"
                size="icon"
                className="hover:text-destructive"
                onClick={() => void controlRun({ command: 'stop' })}
              >
                <Square />
              </Button>
            </Tooltip>
          )}
          {!live && resumable && (
            <Tooltip content={t('Resume run')}>
              <Button variant="omk" size="sm" className="gap-1.5" onClick={() => void resumeRun(runId)}>
                <Play className="size-3.5" />
                {t('Resume')}
              </Button>
            </Tooltip>
          )}
          {!live && status === 'failed' && (
            <Tooltip content={t('Reset the failed tasks and run again')}>
              <Button variant="omk" size="sm" className="gap-1.5" onClick={() => void retryRun(runId)}>
                <RotateCw className="size-3.5" />
                {t('Retry')}
              </Button>
            </Tooltip>
          )}
        </div>
      </div>

      <GateDialog
        gate={openGate}
        onAnswer={(answer) => {
          if (openGate?.gateId) void controlRun({ command: 'answer-gate', gateId: openGate.gateId, answer });
        }}
      />
    </div>
  );
}

export function Cockpit() {
  const currentRunId = useAppStore((s) => s.currentRunId);
  return currentRunId ? <LiveCockpit runId={currentRunId} /> : <NewRunComposer />;
}
