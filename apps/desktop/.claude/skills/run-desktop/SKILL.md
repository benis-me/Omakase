---
name: run-desktop
description: Build, launch, and drive the Omakase desktop (Electron) app. Use when asked to start the desktop app, screenshot it, or interact with its UI.
---

Omakase is an Electron + React desktop app. For agent/automated use, drive it via
the Playwright `_electron` REPL at `apps/desktop/.claude/skills/run-desktop/driver.mjs`.

This is **macOS-native** — no xvfb. Electron opens a real window, and Playwright
screenshots the BrowserWindow's own surface over CDP, so it works **without macOS
Screen Recording permission** (the OS-level screen-capture grant is irrelevant here).

All paths below are relative to the repo root unless noted.

## Build first (the driver launches the BUILT app, not dev)

```bash
pnpm --filter @omakase/desktop build          # → apps/desktop/out/{main,preload,renderer}
pnpm --filter @omakase/desktop rebuild:electron  # CRITICAL — see Gotchas
```

`playwright-core` is already a devDependency of `@omakase/desktop`; `pnpm install`
provides it.

## Run (agent path)

```bash
tmux new-session -d -s omks -x 220 -y 50
tmux send-keys -t omks 'node apps/desktop/.claude/skills/run-desktop/driver.mjs' Enter
until tmux capture-pane -t omks -p | grep -q 'driver>'; do sleep 0.2; done
tmux send-keys -t omks 'launch' Enter
until tmux capture-pane -t omks -p | grep -q 'launched'; do sleep 0.2; done
tmux send-keys -t omks 'addws' Enter      # scaffold + open a throwaway workspace
tmux send-keys -t omks 'ss landing' Enter
tmux capture-pane -t omks -p
```

Then actually open the PNG (default dir `$TMPDIR/omks-shots/`, override `SCREENSHOT_DIR`).
A blank frame is a launch failure, not success.

One-shot (no tmux) also works: pipe commands into `node driver.mjs`.

### Commands

| command | what it does |
|---|---|
| `launch` | launch the built app, force the window visible, wait for React |
| `addws` | scaffold a temp workspace and activate it via IPC (renders the full UI) |
| `ss [name]` | screenshot → `$SCREENSHOT_DIR/<name>.png` |
| `theme <dark\|light\|system>` | set theme via the real setting; prints the `<html>` class |
| `lang <en\|zh>` | switch UI language (i18n) |
| `nav <label>` | click a left-nav section by label (English or 中文) |
| `click <css>` / `type <text>` / `press <key>` | DOM click / keyboard |
| `eval <js>` | evaluate in the renderer, print JSON (e.g. `eval window.omakase.versions`) |
| `text [css]` | print innerText of body or a selector |
| `windows` | list open windows |
| `quit` | close app, exit |

## Run (human path)

```bash
pnpm --filter @omakase/desktop dev   # electron-vite dev; opens a window. Ctrl-C to quit.
```

## Gotchas

- **better-sqlite3 ABI must match the runtime.** The repo keeps native modules at the
  **Node** ABI so `pnpm -r test` runs under Node. The app's main process loads SQLite
  under **Electron's** ABI, so before launching you MUST
  `pnpm --filter @omakase/desktop rebuild:electron` (electron-builder install-app-deps),
  or the main process crashes opening the registry DB. Afterward the test suite's vitest
  `globalSetup` (`scripts/ensure-node-sqlite.mjs`) self-heals it back to Node ABI on the
  next `pnpm -r test` — no manual step.
- **The window is created `show:false`.** The driver calls `BrowserWindow.show()` via
  `app.evaluate` after launch so screenshots aren't blank.
- **Launch the built app, not dev.** `_electron.launch` points at `apps/desktop` and loads
  `out/main/index.js`, which loads the production `out/renderer/index.html` (no Vite dev
  server). Run the build step first or you'll launch a stale/empty bundle.
- **`workspaces.add(path)` returns an ActiveWorkspace with `.path`** (not `.root`). On a
  fresh app with no `lastWorkspace`, the landing is an empty state — use `addws` to get
  into the real UI.
- **Screen Recording permission is NOT needed.** Screenshots come from CDP, not the OS
  screen grabber. (Driving via `electron-vite dev` previously exited 144 — prefer this
  built-app path.)

## Troubleshooting

- **Launch timeout (30s):** build output missing → run the build step. Stale Electron →
  `pkill -f Electron`.
- **Main crashes immediately:** almost always the SQLite ABI — run `rebuild:electron`.
- **`Cannot find module 'playwright-core'`:** run `pnpm install` (it's a desktop devDep).
