import { useEffect, useMemo, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Pause, Play, Send, Square, Trash2, X } from 'lucide-react';
import type { AutonomyLevel, CockpitEvent, RunMode, SpecDoc } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { Button } from '../ui/button';
import { StatusDot, type DotStatus } from '../StatusDot';
import { CockpitFeed } from './CockpitFeed';

export const RUN_DOT: Record<string, DotStatus> = {
  running: 'omk',
  paused: 'warn',
  pending: 'warn',
  'waiting-for-user': 'warn',
  incomplete: 'warn',
  succeeded: 'run',
  failed: 'fail',
  cancelled: 'idle',
};

const LIVE = new Set(['running', 'paused', 'pending', 'waiting-for-user']);

function NewRunComposer() {
  const startRun = useAppStore((s) => s.startRun);
  const settings = useAppStore((s) => s.settings);
  const [prompt, setPrompt] = useState('');
  const [specId, setSpecId] = useState('');
  const [specs, setSpecs] = useState<SpecDoc[]>([]);
  const [mode, setMode] = useState<RunMode>(settings?.defaultMode ?? 'normal');
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(settings?.defaultAutonomy ?? 'low');

  useEffect(() => {
    void window.omakase.specs.list().then(setSpecs);
  }, []);

  const canRun = specId !== '' || prompt.trim().length > 0;
  const run = (): void => {
    if (!canRun) return;
    void startRun({ ...(specId ? { specId } : { prompt: prompt.trim() }), mode, autonomy });
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col justify-center gap-4 p-8">
      <div>
        <h1 className="text-[18px] font-semibold tracking-tight">Start a run</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Hand a spec or a task to the loop. It plans, executes, verifies, and reports — you steer.
        </p>
      </div>
      {specs.length > 0 && (
        <label className="block">
          <span className="mb-1 block text-[12px] text-muted-foreground">From a spec (optional)</span>
          <select
            value={specId}
            onChange={(e) => setSpecId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-[13px]"
          >
            <option value="">— none —</option>
            {specs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={specId ? 'Optional extra instructions…' : 'Describe the task…'}
        rows={5}
        className="w-full resize-none rounded-md border bg-background p-3 font-mono text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      />
      <div className="flex items-center gap-2">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as RunMode)}
          className="rounded-md border bg-background px-2 py-1.5 text-[12px]"
        >
          <option value="normal">normal</option>
          <option value="max-power">max-power</option>
        </select>
        <select
          value={autonomy}
          onChange={(e) => setAutonomy(e.target.value as AutonomyLevel)}
          className="rounded-md border bg-background px-2 py-1.5 text-[12px]"
        >
          <option value="off">autonomy: off</option>
          <option value="low">autonomy: low</option>
          <option value="medium">autonomy: medium</option>
          <option value="high">autonomy: high</option>
        </select>
        <Button variant="omk" size="md" className="ml-auto gap-1.5" disabled={!canRun} onClick={run}>
          <Play className="size-4" />
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
    <Dialog.Root open={Boolean(gate)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <Dialog.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-popover p-5 text-popover-foreground shadow-2xl"
        >
          <Dialog.Title className="text-[15px] font-semibold tracking-tight">
            The run needs your decision
          </Dialog.Title>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {gate?.detail}
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Optional guidance…"
            rows={3}
            className="mt-3 w-full resize-none rounded-md border bg-background p-2 text-[13px] outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
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
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  const live = LIVE.has(status);

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
        <button
          onClick={() => void deleteRun(runId)}
          className="text-muted-foreground hover:text-destructive"
          title="Delete run"
        >
          <Trash2 className="size-4" />
        </button>
        <button onClick={closeRun} className="text-muted-foreground hover:text-foreground" title="Close">
          <X className="size-4" />
        </button>
      </header>

      <CockpitFeed feed={feed} />

      <div className="shrink-0 border-t bg-card/40 p-2">
        <div className="flex items-center gap-1.5">
          <input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') sendSteer();
            }}
            disabled={!live}
            placeholder={live ? 'Queue a steering message…' : 'This run has ended.'}
            className="flex-1 rounded-md border bg-background px-3 py-1.5 text-[13px] outline-none disabled:opacity-50"
          />
          <Button
            variant="ghost"
            size="icon"
            disabled={!live || !steer.trim()}
            onClick={sendSteer}
            title="Queue message"
          >
            <Send className="size-4" />
          </Button>
          {status === 'running' && (
            <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'pause' })} title="Pause">
              <Pause className="size-4" />
            </Button>
          )}
          {status === 'paused' && (
            <Button variant="ghost" size="icon" onClick={() => void controlRun({ command: 'resume' })} title="Resume">
              <Play className="size-4" />
            </Button>
          )}
          {live && (
            <Button
              variant="ghost"
              size="icon"
              className="hover:text-destructive"
              onClick={() => void controlRun({ command: 'stop' })}
              title="Stop"
            >
              <Square className="size-4" />
            </Button>
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
