// REPL driver for the Omakase desktop app. macOS-native (no xvfb): Electron opens
// a real window and Playwright's _electron screenshots the BrowserWindow's own
// surface over CDP — so it works WITHOUT macOS Screen Recording permission.
//
// Designed for agents: wrap in tmux, send-keys commands, capture-pane output.
// Paths are resolved relative to this file, so it survives version bumps.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import * as readline from 'node:readline';
import { mkdtempSync, mkdirSync, openSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(import.meta.dirname, '../../..'); // → apps/desktop
const ELECTRON_BIN = require('electron'); // npm 'electron' exports the binary path
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(tmpdir(), 'omks-shots');
mkdirSync(SHOT_DIR, { recursive: true });

let app = null;
let page = null;

const COMMANDS = {
  async launch() {
    if (app) return console.log('already launched');
    app = await electron.launch({
      executablePath: ELECTRON_BIN,
      args: ['--no-sandbox', APP_DIR], // loads APP_DIR/out/main/index.js (build first!)
      cwd: APP_DIR,
      timeout: 30_000,
    });
    page = await app.firstWindow();
    // The window is created with show:false; force it visible so the compositor paints.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500); // React mount + fonts
    console.log('launched.', app.windows().length, 'window(s):');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async ss(name) {
    if (!page) return console.log('ERROR: launch first');
    const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png');
    await page.screenshot({ path: f });
    console.log('screenshot:', f);
  },

  // App-specific: scaffold a throwaway workspace and activate it via the real IPC,
  // so the full sidebar+content UI renders. ActiveWorkspace exposes `.path`.
  async addws() {
    if (!page) return console.log('ERROR: launch first');
    const dir = mkdtempSync(path.join(tmpdir(), 'omks-drive-'));
    const res = await page.evaluate(async (d) => {
      const ws = await window.omakase.workspaces.add(d);
      return ws?.path ?? '(added, no path returned)';
    }, dir);
    await page.waitForTimeout(1200);
    console.log('workspace:', res);
  },

  async theme(mode) {
    if (!page) return console.log('ERROR: launch first');
    await page.evaluate((m) => window.omakase.settings.set({ theme: m }), mode || 'dark');
    await page.waitForTimeout(600);
    console.log('theme →', mode, '| html class:', await page.evaluate(() => document.documentElement.className));
  },

  async lang(code) {
    if (!page) return console.log('ERROR: launch first');
    await page.evaluate((c) => window.omakase.settings.set({ language: c }), code || 'en');
    await page.waitForTimeout(800);
    console.log('language →', code);
  },

  // Click a left-nav section by its visible label (English or 中文).
  async nav(label) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((t) => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
      const el = els.find((e) => e.textContent?.trim() === t) ?? els.find((e) => e.textContent?.includes(t));
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, label);
    await page.waitForTimeout(500);
    console.log('nav', JSON.stringify(label), '→', r);
  },

  async click(sel) {
    if (!page) return console.log('ERROR: launch first');
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return 'NOT_FOUND';
      el.click();
      return 'OK';
    }, sel);
    console.log('click', sel, '→', r);
  },

  async type(text) {
    if (page) await page.keyboard.type(text, { delay: 30 });
  },
  async press(key) {
    if (page) await page.keyboard.press(key);
  },

  async eval(expr) {
    if (!page) return console.log('ERROR: launch first');
    try {
      console.log(JSON.stringify(await page.evaluate(expr)));
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  },

  async text(sel) {
    if (!page) return console.log('ERROR: launch first');
    console.log(
      await page.evaluate((s) => (s ? document.querySelector(s) : document.body)?.innerText ?? '(null)', sel || null),
    );
  },

  async windows() {
    if (!app) return console.log('ERROR: launch first');
    for (const w of app.windows()) console.log(' ', w.url());
  },

  async quit() {
    if (app) await app.close().catch(() => {});
    app = null;
    page = null;
  },
  help() {
    console.log('commands:', Object.keys(COMMANDS).join(', '));
  },
};

// Stop Electron from stealing stdin — read the raw fd.
const stdin = createReadStream(null, { fd: openSync('/dev/stdin', 'r') });
const rl = readline.createInterface({ input: stdin, output: process.stdout, prompt: 'driver> ' });
rl.on('line', async (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return rl.prompt();
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.log('unknown:', cmd, '— try: help');
    return rl.prompt();
  }
  try {
    await fn(rest.join(' '));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
  if (cmd === 'quit') {
    rl.close();
    process.exit(0);
  }
  rl.prompt();
});
rl.on('close', async () => {
  await COMMANDS.quit();
  process.exit(0);
});

console.log('omakase desktop driver — "help" for commands, "launch" to start');
console.log('app dir:', APP_DIR);
rl.prompt();
