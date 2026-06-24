import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { WorkspaceHost } from './workspace-host.js';
import { registerIpc } from './ipc/register.js';

let mainWindow: BrowserWindow | null = null;
let host: WorkspaceHost;

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

  const settings = host.getSettings();
  nativeTheme.themeSource = settings.theme;

  registerIpc(host, () => mainWindow);

  // Restore the last workspace (best-effort; a deleted folder is just skipped).
  if (settings.lastWorkspace) {
    try {
      host.open(settings.lastWorkspace);
    } catch {
      /* folder gone — leave inactive */
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => host?.shutdown());
