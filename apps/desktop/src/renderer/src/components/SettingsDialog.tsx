import type { ReactNode } from 'react';
import type { AutonomyLevel, ThemeMode, WorkModeName } from '@shared/types';
import { useAppStore } from '@/store/useAppStore';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const THEMES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];
const AUTONOMY: AutonomyLevel[] = ['off', 'low', 'medium', 'high'];
const MODES: WorkModeName[] = ['normal', 'max-power', 'custom'];

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

export function SettingsDialog() {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md gap-3">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Appearance, and the defaults applied to new runs.</DialogDescription>
        </DialogHeader>
        {settings && (
          <div className="-my-1 divide-y divide-border">
            <Row label="Theme" hint="App appearance">
              <Select value={settings.theme} onValueChange={(v) => void update({ theme: v as ThemeMode })}>
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THEMES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Default autonomy" hint="How far a run proceeds before it pauses to ask">
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
            <Row label="Default work mode" hint="Agent + model selection strategy">
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
        )}
      </DialogContent>
    </Dialog>
  );
}
