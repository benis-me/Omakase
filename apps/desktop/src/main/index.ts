import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IPC } from '@shared/ipc';
import { WorkspaceHost } from './workspace-host.js';
import { DevController } from './dev-controller.js';
import { ContentController } from './content-controller.js';
import { RunHost } from './run-host.js';
import { TrayController } from './tray.js';
import { registerIpc } from './ipc/register.js';

let mainWindow: BrowserWindow | null = null;
let host: WorkspaceHost;
let dev: DevController;
let runs: RunHost;
let tray: TrayController | null = null;

function showMainWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0d0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => (mainWindow = null));

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  const registryFile = join(app.getPath('userData'), 'registry.db');
  host = new WorkspaceHost(registryFile);

  const send = (channel: string, payload: unknown): void => {
    mainWindow?.webContents.send(channel, payload);
  };
  dev = new DevController({
    scriptData: (id, chunk) => send(IPC.EvtScriptData, { id, chunk }),
    scriptStatus: (session) => send(IPC.EvtScriptStatus, session),
    scriptUrl: (id, url) => send(IPC.EvtScriptUrl, { id, url }),
    projectsUpdated: (projects) => send(IPC.EvtProjectsUpdated, projects),
    portConflict: (id, port) => send(IPC.EvtPortConflict, { id, port }),
  });
  host.setActiveListener((ws) => void dev.setWorkspace(ws));
  const content = new ContentController(host);
  runs = new RunHost(host, {
    cockpitEvent: (runId, event) => send(IPC.EvtRunEvent, { runId, event }),
    runStatus: (runId) => send(IPC.EvtRunStatus, runId),
    liveChanged: (count) => tray?.update(count),
  });

  const settings = host.getSettings();
  nativeTheme.themeSource = settings.theme;

  registerIpc(host, dev, content, runs, () => mainWindow);

  // Restore the last workspace (best-effort; a deleted folder is just skipped).
  if (settings.lastWorkspace) {
    try {
      host.open(settings.lastWorkspace);
    } catch {
      /* folder gone — leave inactive */
    }
  }

  createWindow();
  tray = new TrayController(showMainWindow);
  tray.init();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// On macOS, keep the process (and any in-process runs) alive when the window is
// closed — the tray reopens it. Other platforms quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  runs?.shutdown();
  dev?.shutdown();
  host?.shutdown();
});

app.on('will-quit', () => tray?.destroy());
