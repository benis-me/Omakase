/**
 * Detect installed editors/terminals and open a folder (or run a command) in
 * them. macOS-focused (uses `open` + `sips` for icons), ported from DevDock.
 */
import { shell } from 'electron';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppInfo } from '@shared/types';

interface KnownApp {
  id: string;
  name: string;
  appName: string;
  kind: AppInfo['kind'];
}

const KNOWN: readonly KnownApp[] = [
  { id: 'vscode', name: 'VS Code', appName: 'Visual Studio Code.app', kind: 'editor' },
  { id: 'cursor', name: 'Cursor', appName: 'Cursor.app', kind: 'editor' },
  { id: 'windsurf', name: 'Windsurf', appName: 'Windsurf.app', kind: 'editor' },
  { id: 'zed', name: 'Zed', appName: 'Zed.app', kind: 'editor' },
  { id: 'sublime', name: 'Sublime Text', appName: 'Sublime Text.app', kind: 'editor' },
  { id: 'webstorm', name: 'WebStorm', appName: 'WebStorm.app', kind: 'editor' },
  { id: 'idea', name: 'IntelliJ IDEA', appName: 'IntelliJ IDEA.app', kind: 'editor' },
  { id: 'pycharm', name: 'PyCharm', appName: 'PyCharm.app', kind: 'editor' },
  { id: 'goland', name: 'GoLand', appName: 'GoLand.app', kind: 'editor' },
  { id: 'xcode', name: 'Xcode', appName: 'Xcode.app', kind: 'editor' },
  { id: 'iterm', name: 'iTerm', appName: 'iTerm.app', kind: 'terminal' },
  { id: 'ghostty', name: 'Ghostty', appName: 'Ghostty.app', kind: 'terminal' },
  { id: 'warp', name: 'Warp', appName: 'Warp.app', kind: 'terminal' },
  { id: 'kitty', name: 'kitty', appName: 'kitty.app', kind: 'terminal' },
  { id: 'alacritty', name: 'Alacritty', appName: 'Alacritty.app', kind: 'terminal' },
  { id: 'wezterm', name: 'WezTerm', appName: 'WezTerm.app', kind: 'terminal' },
  { id: 'terminal', name: 'Terminal', appName: 'Terminal.app', kind: 'terminal' },
];

const SEARCH_DIRS = [
  '/Applications',
  join(homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities',
];
const FINDER_PATH = '/System/Library/CoreServices/Finder.app';
const KNOWN_BY_ID = new Map(KNOWN.map((k) => [k.id, k]));

function findAppPath(appName: string): string | null {
  for (const dir of SEARCH_DIRS) {
    const p = join(dir, appName);
    if (existsSync(p)) return p;
  }
  return null;
}

function iconFor(appPath: string): string | null {
  try {
    const resDir = join(appPath, 'Contents', 'Resources');
    const icns = readdirSync(resDir).filter((f) => f.toLowerCase().endsWith('.icns'));
    if (icns.length === 0) return null;
    const pick = icns.find((f) => /appicon|^icon/i.test(f)) ?? icns[0];
    const tmp = join(tmpdir(), `omakase-app-icon-${Date.now()}.png`);
    execFileSync('sips', ['-s', 'format', 'png', '-z', '64', '64', join(resDir, pick), '--out', tmp], {
      stdio: 'ignore',
    });
    return `data:image/png;base64,${readFileSync(tmp).toString('base64')}`;
  } catch {
    return null;
  }
}

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class AppLauncher {
  private apps: AppInfo[] | null = null;
  private readonly paths = new Map<string, string>();

  list(): AppInfo[] {
    if (this.apps) return this.apps;
    const apps: AppInfo[] = [];
    if (process.platform === 'darwin') {
      for (const k of KNOWN) {
        const path = findAppPath(k.appName);
        if (!path) continue;
        this.paths.set(k.id, path);
        apps.push({ id: k.id, name: k.name, path, kind: k.kind, icon: iconFor(path) });
      }
      this.paths.set('finder', FINDER_PATH);
      apps.push({ id: 'finder', name: 'Finder', path: FINDER_PATH, kind: 'other', icon: iconFor(FINDER_PATH) });
    }
    this.apps = apps;
    return apps;
  }

  openWith(appId: string, folder: string): void {
    if (appId === 'finder') {
      void shell.openPath(folder);
      return;
    }
    const appPath = this.appPathFor(appId);
    if (!appPath) {
      void shell.openPath(folder);
      return;
    }
    execFile('open', ['-a', appPath, folder], () => {});
  }

  runInTerminal(appId: string, cwd: string, command: string): void {
    const script = `#!/bin/zsh\ncd ${singleQuote(cwd)}\n${command}\n`;
    const file = join(tmpdir(), `omakase-run-${Date.now()}.command`);
    try {
      writeFileSync(file, script);
      chmodSync(file, 0o755);
    } catch {
      return;
    }
    const appPath = this.appPathFor(appId);
    const args = appPath ? ['-a', appPath, file] : [file];
    execFile('open', args, () => {});
  }

  private appPathFor(appId: string): string | null {
    const cached = this.paths.get(appId);
    if (cached) return cached;
    const k = KNOWN_BY_ID.get(appId);
    return k ? findAppPath(k.appName) : null;
  }
}
