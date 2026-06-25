import { useEffect, useRef } from 'react';
import { Terminal as Xterm, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '@/store/useAppStore';

const DARK: ITheme = {
  background: '#0d0d0d',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  selectionBackground: 'rgba(120,140,170,0.35)',
};
const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  selectionBackground: 'rgba(0,0,0,0.12)',
};
const themeNow = (): ITheme =>
  document.documentElement.classList.contains('dark') ? DARK : LIGHT;

export function DevTerminal() {
  const selected = useAppStore((s) => s.selectedTerminal);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const selectedRef = useRef<string | null>(null);

  // Create the terminal once and bridge it to the active script's pty.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Xterm({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      theme: themeNow(),
      cursorBlink: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => void window.omakase.shell.openExternal(uri)));
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet */
    }
    termRef.current = term;
    fitRef.current = fit;

    const onData = term.onData((data) => {
      if (selectedRef.current) void window.omakase.terminal.write(selectedRef.current, data);
    });
    const resizeObs = new ResizeObserver(() => {
      try {
        fit.fit();
        if (selectedRef.current) {
          void window.omakase.terminal.resize(selectedRef.current, term.cols, term.rows);
        }
      } catch {
        /* ignore */
      }
    });
    resizeObs.observe(el);
    const themeObs = new MutationObserver(() => {
      term.options.theme = themeNow();
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const unsub = window.omakase.onScriptData(({ id, chunk }) => {
      if (id === selectedRef.current) term.write(chunk);
    });

    return () => {
      onData.dispose();
      resizeObs.disconnect();
      themeObs.disconnect();
      unsub();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Swap to the selected script's buffer when it changes.
  useEffect(() => {
    selectedRef.current = selected;
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (!selected) return;
    void (async () => {
      const buffer = await window.omakase.terminal.getBuffer(selected);
      term.write(buffer);
      try {
        fitRef.current?.fit();
        void window.omakase.terminal.resize(selected, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    })();
  }, [selected]);

  return (
    <div className="relative h-full bg-[var(--term-bg)]">
      <div ref={containerRef} className="absolute inset-0 p-2" />
      {!selected && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-[12px] text-muted-foreground">
          Select a script to view its output.
        </div>
      )}
    </div>
  );
}
