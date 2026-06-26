import { useEffect, useMemo, useState } from 'react';
import { Pause, Play, Send, Square, Trash2, X } from 'lucide-react';
import type { AutonomyLevel, CockpitEvent, RunMode, SpecDoc } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
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
import { LIVE_STATUSES, RUN_DOT } from './run-status';

function NewRunComposer() {
  const startRun = useAppStore((s) => s.startRun);
  const settings = useAppStore((s) => s.settings);
  const [prompt, setPrompt] = useState('');
  const [specId, setSpecId] = useState('none');
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [mode, setMode] = useState<RunMode>(settings?.defaultMode ?? 'normal');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(settings?.defaultAutonomy ?? 'low');

  useEffect(() => {
    void window.omakase.specs.list().then(setSpecs);
  }, []);

  const usingSpec = specId !== 'none';
  const canRun = usingSpec || prompt.trim().length > 0;
  const run = (): void => {
    if (!canRun) return;
    void startRun({ ...(usingSpec ? { specId } : { prompt: prompt.trim() }), mode, autonomy });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-5 p-8">
      <div className="space-y-1.5">
        <h1 className="text-[19px] font-semibold tracking-tight">Start a run</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Hand a spec or a task to the loop. It plans, executes, verifies, and reports — you steer.
        </p>
      </div>

      {specs.length > 0 && (
        <div className="space-y-1.5">
          <Label>From a spec</Label>
          <Select value={specId} onValueChange={setSpecId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="None — write a task below" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None — write a task below</SelectItem>
              {specs.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={usingSpec ? 'Optional extra instructions…' : 'Describe the task…'}
        rows={5}
        className="resize-none font-mono"
      />

      <div className="flex items-center gap-2">
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
                autonomy: {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="omk" className="ml-auto" disabled={!canRun} onClick={run}>
          <Play />
          Run
        </Button>
      </div>
    </div>
  );
}

function GateDialog({ gate, onAnswer }: { gate: CockpitEvent | null; onAnswer: (answer: string) => void }) {
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
          <DialogTitle>The run needs your decision</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap text-foreground">
            {gate?.detail}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Optional guidance…"
          rows={3}
          className="resize-none"
        />
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onAnswer(text.trim() || 'Hold — keep iterating, do not proceed yet.')}
          >
            Hold
          </Button>
          <Button
            variant="omk"
            size="sm"
            onClick={() => onAnswer(text.trim() ? `Proceed. ${text.trim()}` : 'Proceed.')}
          >
            Approve &amp; proceed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LiveCockpit({ runId }: { runId: string }) {
  const feed = useAppStore((s) => s.feed);
  const runs = useAppStore((s) => s.runs);
  const controlRun = useAppStore((s) => s.controlRun);
  const closeRun = useAppStore((s) => s.closeRun);
  const deleteRun = useAppStore((s) => s.deleteRun);
  const [steer, setSteer] = useState('');

  const summary = runs.find((r) => r.id === runId);
  const status = summary?.status ?? 'running';
  const live = LIVE_STATUSES.has(status);

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
        <StatusDot status={RUN_DOT[status] ?? 'idle'} pulse={status === 'running'} glow={status === 'running'} />
        <span className="text-[13px] font-medium capitalize">{status.replace(/-/g, ' ')}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{summary?.summary}</span>
        {summary && (summary.spentTokens ?? 0) > 0 && (
          <span className="font-mono text-[11px] text-muted-foreground">{summary.spentTokens} tok</span>
        )}
        <Tooltip content="Delete run">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => void deleteRun(runId)}
          >
            <Trash2 />
          </Button>
        </Tooltip>
        <Tooltip content="Close">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={closeRun}>
            <X />
          </Button>
        </Tooltip>
      </header>

      <CockpitTabs feed={feed} />

      <div className="shrink-0 border-t bg-card/40 p-2">
        <div className="flex items-center gap-1.5">
          <Input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendSteer();
            }}
            disabled={!live}
            placeholder={live ? 'Queue a steering message…' : 'This run has ended.'}
          />
          <Tooltip content="Queue message">
            <Button variant="ghost" size="icon" disabled={!live || !steer.trim()} onClick={sendSteer}>
              <Send />
            </Button>
          </Tooltip>
          {status === 'running' && (
            <Tooltip content="Pause">
              <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'pause' })}>
                <Pause />
              </Button>
            </Tooltip>
          )}
          {status === 'paused' && (
            <Tooltip content="Resume">
              <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'resume' })}>
                <Play />
              </Button>
            </Tooltip>
          )}
          {live && (
            <Tooltip content="Stop">
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
