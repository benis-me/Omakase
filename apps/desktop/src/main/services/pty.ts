/**
 * Thin seam over node-pty so the ProcessManager is unit-testable with a fake
 * spawner (the real one lazily `require`s the native module, so tests that
 * inject a fake never load it). Ported from DevDock.
 */
export interface IPty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export type PtySpawner = (command: string, opts: SpawnOptions) => IPty;

export const realPtySpawner: PtySpawner = (command, opts) => {
  // Lazy require so unit tests that inject a fake spawner never load the native
  // module (and so a missing/ABI-mismatched build fails only at real spawn time).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require('node-pty') as typeof import('node-pty');
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
  // An interactive login shell (-ilc) reads .zshrc/.bashrc, so nvm/fnm/Homebrew
  // PATH setup matches the user's terminal — a GUI-launched .app otherwise gets a
  // stripped PATH and the wrong node.
  const args = process.platform === 'win32' ? ['-Command', command] : ['-ilc', command];
  const proc = pty.spawn(shell, args, {
    name: 'xterm-color',
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols,
    rows: opts.rows,
  });
  return {
    pid: proc.pid,
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit((e: { exitCode: number }) => cb({ exitCode: e.exitCode })),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: (s) => proc.kill(s),
  };
};
