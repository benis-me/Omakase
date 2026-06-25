/**
 * Manages long-running script processes via node-pty: start/stop/restart, a
 * rolling output buffer, and live status/url/port-conflict events. Ported from
 * DevDock's ProcessManager, keyed by `ScriptInfo.id`. Spawner is injectable for
 * tests. Listen via `.on('data'|'status'|'url'|'port-conflict', ...)`.
 */
import { EventEmitter } from 'node:events';
import type { ScriptSession } from '@shared/types';
import { detectPortConflict, detectUrl, stripAnsi } from './url-detect.js';
import { realPtySpawner, type IPty, type PtySpawner } from './pty.js';

interface Session {
  state: ScriptSession;
  pty: IPty;
  buffer: string;
  stopRequested: boolean;
  killTimer?: NodeJS.Timeout;
  conflictPort?: number;
}

const BUFFER_LIMIT = 200_000;

const NOOP_PTY: IPty = {
  pid: -1,
  onData: () => {},
  onExit: () => {},
  write: () => {},
  resize: () => {},
  kill: () => {},
};

export interface StartOptions {
  id: string;
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class ProcessManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly spawner: PtySpawner = realPtySpawner) {
    super();
  }

  start(opts: StartOptions): void {
    this.stop(opts.id); // restart is idempotent

    let pty: IPty;
    try {
      pty = this.spawner(opts.command, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, FORCE_COLOR: '1' },
        cols: 80,
        rows: 24,
      });
    } catch (err) {
      const message = `\r\n[omakase] failed to start: ${(err as Error)?.message ?? String(err)}\r\n`;
      const state: ScriptSession = { id: opts.id, status: 'errored', pid: null, url: null, startedAt: Date.now(), exitCode: null };
      this.sessions.set(opts.id, { state, pty: NOOP_PTY, buffer: message, stopRequested: false });
      this.emit('data', opts.id, message);
      this.emit('status', { ...state });
      return;
    }

    const state: ScriptSession = { id: opts.id, status: 'starting', pid: pty.pid, url: null, startedAt: Date.now(), exitCode: null };
    const session: Session = { state, pty, buffer: '', stopRequested: false };
    this.sessions.set(opts.id, session);
    this.emit('status', { ...state });

    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-BUFFER_LIMIT);
      this.emit('data', opts.id, data);
      if (session.state.status === 'starting') {
        session.state.status = 'running';
        this.emit('status', { ...session.state });
      }
      if (!session.state.url) {
        const url = detectUrl(data);
        if (url) {
          session.state.url = url;
          this.emit('url', opts.id, url);
        }
      }
      const port = detectPortConflict(stripAnsi(data));
      if (port && session.conflictPort !== port) {
        session.conflictPort = port;
        this.emit('port-conflict', opts.id, port);
      }
    });

    pty.onExit(({ exitCode }) => {
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = undefined;
      }
      session.state.status = session.stopRequested || exitCode === 0 ? 'exited' : 'errored';
      session.state.exitCode = exitCode;
      session.state.url = null;
      const note = `\r\n\x1b[2m── omakase: process exited (code ${exitCode}) ──\x1b[0m\r\n`;
      session.buffer = (session.buffer + note).slice(-BUFFER_LIMIT);
      this.emit('data', opts.id, note);
      this.emit('status', { ...session.state });
    });
  }

  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.state.status === 'starting' || s.state.status === 'running') {
      s.stopRequested = true;
      s.killTimer = setTimeout(() => {
        try {
          s.pty.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000);
      try {
        s.pty.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  }

  write(id: string, data: string): void {
    try {
      this.sessions.get(id)?.pty.write(data);
    } catch {
      /* pty closed */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      /* pty closed */
    }
  }

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  clearBuffer(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.buffer = '';
  }

  list(): ScriptSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.state }));
  }

  killAll(): void {
    for (const id of this.sessions.keys()) this.stop(id);
  }
}
