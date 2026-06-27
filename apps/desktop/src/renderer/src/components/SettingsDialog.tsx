import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Cpu, Play, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { AutonomyLevel, DetectedAgentDto, Language, ThemeMode, WorkModeName } from '@shared/types';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useT } from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { StatusDot } from './StatusDot';

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
];
const AUTONOMY: AutonomyLevel[] = ['off', 'low', 'medium', 'high'];
// 'custom' is omitted — it has no configurable policy yet, so it behaves like the default.
const MODES: WorkModeName[] = ['normal', 'max-power'];
const SUPPORTED = ['claude', 'codex', 'copilot', 'cursor-agent', 'gemini', 'opencode', 'pi', 'qwen'];

type SectionId = 'general' | 'runs' | 'agents';
const SECTIONS: { id: SectionId; label: string; icon: typeof Cpu }[] = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'runs', label: 'Run defaults', icon: Play },
  { id: 'agents', label: 'Agent CLIs', icon: Cpu },
];

function Row({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">{hint}</div>
      </div>
      {children}
    </div>
  );
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <h3 className="text-[14px] font-semibold tracking-tight">{children}</h3>
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

function GeneralPanel() {
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);
  const t = useT();
  if (!settings) return null;
  return (
    <div>
      <SectionTitle>{t('General')}</SectionTitle>
      <p className="mb-2 text-[12px] text-muted-foreground">{t('Appearance and app-level preferences.')}</p>
      <div className="divide-y divide-border">
        <Row label={t('Theme')} hint={t('App appearance')}>
          <Select value={settings.theme} onValueChange={(v) => void update({ theme: v as ThemeMode })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((th) => (
                <SelectItem key={th.value} value={th.value}>
                  {t(th.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('Language')} hint="">
          <Select value={settings.language} onValueChange={(v) => void update({ language: v as Language })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </div>
    </div>
  );
}

function RunDefaultsPanel() {
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);
  const t = useT();
  if (!settings) return null;
  return (
    <div>
      <SectionTitle>{t('Run defaults')}</SectionTitle>
      <p className="mb-2 text-[12px] text-muted-foreground">
        {t('Applied to new runs (overridable per run when you start one).')}
      </p>
      <div className="divide-y divide-border">
        <Row label={t('Default autonomy')} hint={t('How far a run proceeds before it pauses to ask')}>
          <Select
            value={settings.defaultAutonomy}
            onValueChange={(v) => void update({ defaultAutonomy: v as AutonomyLevel })}
          >
            <SelectTrigger className="w-36 capitalize">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY.map((a) => (
                <SelectItem key={a} value={a} className="capitalize">
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('Default work mode')} hint={t('Agent + model selection strategy')}>
          <Select
            value={settings.defaultMode}
            onValueChange={(v) => void update({ defaultMode: v as WorkModeName })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </div>
    </div>
  );
}

function AgentsPanel({
  detected,
  scanning,
  onRescan,
}: {
  detected: DetectedAgentDto[];
  scanning: boolean;
  onRescan: () => void;
}) {
  const t = useT();
  return (
    <div>
      <SectionTitle
        action={
          <Button variant="outline" size="sm" className="gap-1.5" disabled={scanning} onClick={onRescan}>
            <RefreshCw className={cn('size-3.5', scanning && 'animate-spin')} />
            {scanning ? t('Scanning…') : t('Rescan')}
          </Button>
        }
      >
        {t('Agent CLIs')}
      </SectionTitle>
      <p className="mb-3 text-[12px] leading-relaxed text-muted-foreground">
        {t('Detected on your')} <span className="font-mono">PATH</span>{' '}
        {t('and common toolchain dirs. Runs spawn their sub-agents through these; pick which to use when you start a run.')}
      </p>

      {detected.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {scanning ? t('Scanning…') : t('No agent CLIs found. Install one and Rescan.')}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          {detected.map((d, i) => (
            <div
              key={d.id}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2.5',
                i > 0 && 'border-t',
                !d.available && 'opacity-60',
              )}
            >
              <StatusDot status={d.available ? 'run' : 'idle'} />
              <span className="text-[13px] font-medium">{d.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{d.id}</span>
              <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                {d.available ? (d.version ?? 'available') : 'not found'}
              </span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        {t('Supported:')} {SUPPORTED.join(' · ')}. {t('Any installed on your PATH is detected automatically.')}
      </p>
    </div>
  );
}

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const t = useT();
  const [section, setSection] = useState<SectionId>('general');
  const [detected, setDetected] = useState<DetectedAgentDto[]>([]);
  const [scanning, setScanning] = useState(false);

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      setDetected(await window.omakase.agents.detect());
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (open) void rescan();
  }, [open, rescan]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[520px] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-3.5">
          <DialogTitle>{t('Settings')}</DialogTitle>
          <DialogDescription className="sr-only">{t('App and run settings')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <nav className="w-44 shrink-0 space-y-0.5 border-r p-2">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors',
                    active
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', active && 'text-omk')} />
                  {t(s.label)}
                </button>
              );
            })}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {section === 'general' && <GeneralPanel />}
            {section === 'runs' && <RunDefaultsPanel />}
            {section === 'agents' && (
              <AgentsPanel detected={detected} scanning={scanning} onRescan={() => void rescan()} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
