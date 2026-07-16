import { test, expect } from 'bun:test';
import { createElement, act } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { RGBA } from '@opentui/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { RunRecord } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { App } from './app.tsx';
import { SettingsView } from './settings-view.tsx';
import { filterCommands, isCommandInput, parseCommand } from './commands.ts';
import { eventLines, theme } from './render.ts';

const providers: ProviderInfo[] = [
  { id: 'claude', command: 'claude', label: 'Claude', available: true, version: '1', path: '/c', models: ['sonnet'] },
  { id: 'codex', command: 'codex', label: 'Codex', available: true, version: '1', path: '/x', models: [] },
];

function hex(c: RGBA): string {
  return c.toString();
}
function isColor(c: RGBA, want: string): boolean {
  return hex(c) === hex(RGBA.fromHex(want));
}

async function render(width = 100, height = 30, initialGoal?: string, store = new Store(':memory:')) {
  const dir = mkdtempSync(join(tmpdir(), 'omks-tui-'));
  const ws = Workspace.init(dir);
  const setup = await testRender(
    createElement(App, {
      workspace: ws,
      store,
      providers,
      workflows: ['goal', 'auto', 'tdd'],
      onExit: () => {},
      ...(initialGoal ? { initialGoal } : {}),
    }),
    { width, height },
  );
  await setup.renderOnce();
  return { setup, ws, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('TUI renders the redesigned shell', async () => {
  const { setup, cleanup } = await render();
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain('omakase'); // header
    expect(frame).toContain('runs'); // sidebar panel title
    expect(frame).toContain('current'); // live row
    expect(frame).toContain('claude'); // provider chip
    expect(frame).toContain('goal'); // workflow pill
    expect(frame).toContain('commands'); // footer hints ("/ commands")
    expect(frame).toContain('❯'); // prompt caret
    expect(frame).toContain('╭'); // rounded panels are drawn
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

// The two reported bugs: the prompt was invisible on light terminals and the
// borders invisible on dark ones, because nothing set explicit colours. These
// assert the actual rendered colours, so the regression can't come back.
test('legibility: the canvas is painted and never inherits the terminal', async () => {
  const { setup, cleanup } = await render();
  try {
    const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
    expect(spans.length).toBeGreaterThan(0);
    // Every painted cell sits on our own canvas/panel colours — not the terminal's.
    const known = [theme.canvas, theme.panel, theme.panelAlt, theme.inputBg, theme.accent];
    const bgs = spans.filter((s) => s.text.trim().length > 0);
    expect(bgs.some((s) => known.some((k) => isColor(s.bg, k)))).toBe(true);
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

test('legibility: the prompt placeholder has an explicit, readable colour', async () => {
  const { setup, cleanup } = await render();
  try {
    const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
    // Match the input's placeholder exactly (the '…' distinguishes it).
    const ph = spans.find((s) => s.text.includes('Describe a goal…'));
    expect(ph).toBeDefined();
    // Explicitly coloured (bug #1: it used to inherit → invisible on light bg).
    expect(isColor(ph!.fg, theme.placeholder)).toBe(true);
    expect(isColor(ph!.bg, theme.inputBg)).toBe(true);
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

test('legibility: panel borders and the focused input border are explicit', async () => {
  const { setup, cleanup } = await render();
  try {
    const spans = setup.captureSpans().lines.flatMap((l) => l.spans);
    const corners = spans.filter((s) => s.text.includes('╭') || s.text.includes('╰'));
    expect(corners.length).toBeGreaterThan(0);
    // Panels use the visible resting border (bug #2: was too dark to see).
    expect(corners.some((s) => isColor(s.fg, theme.border))).toBe(true);
    // The idle input carries the single accent focus cue.
    expect(corners.some((s) => isColor(s.fg, theme.borderFocus))).toBe(true);
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

test('input: typing "/" opens the command palette with matches', async () => {
  const { setup, cleanup } = await render(100, 30, '/');
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain('commands'); // palette panel title
    expect(frame).toContain('/workflow');
    expect(frame).toContain('/settings');
    expect(frame).toContain('/quit');
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

test('input: palette filters by prefix and shows argument suggestions', async () => {
  const { setup, cleanup } = await render(100, 30, '/workflow ');
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain('/workflow <name>');
    // the selected command offers the real workflow names as suggestions
    expect(frame).toContain('auto');
    expect(frame).toContain('tdd');
    expect(frame).not.toContain('/quit'); // narrowed to the exact command
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

// /cancel is only submittable while the input takes keys — i.e. while nothing
// is running — so its one reachable path must say something rather than
// silently no-op on a null controller.
test('input: /cancel says so when there is nothing to cancel', async () => {
  const { setup, cleanup } = await render();
  try {
    await act(async () => {
      await setup.mockInput.typeText('/cancel');
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('nothing to cancel');
    expect(frame).toContain('esc or ^C'); // points at the keys that do cancel
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

function seedRun(store: Store, id: string, events: number): void {
  const now = Date.now();
  const run: RunRecord = {
    id, sessionId: null, mode: 'goal', workflow: 'goal', status: 'succeeded',
    goal: { text: 'seeded goal' }, title: 'seeded goal', summary: null,
    spentAgents: 0, budgetAgents: null, spentTokens: 0, spentCostUsd: 0,
    lastSeq: 0, checkpointSeq: 0, error: null,
    createdAt: now, updatedAt: now, heartbeatAt: now, rateLimitedUntil: null,
  };
  store.createRun(run);
  for (let i = 0; i < events; i++) store.appendEvent(id, 'phase:started', { name: `Phase ${i}`, index: i });
}

// A stored run's log is read from SQLite. Nothing else re-reads it, so the read
// must be keyed on the selection — an unmemoised read runs on every re-render,
// and the spinner alone re-renders 10x/second for the length of a run.
test('runs: selecting a stored run reads its events once, not on every re-render', async () => {
  const store = new Store(':memory:');
  seedRun(store, 'run_seed_a', 5);
  let reads = 0;
  const real = store.getEvents.bind(store);
  store.getEvents = ((id: string, afterSeq?: number) => {
    reads++;
    return real(id, afterSeq);
  }) as typeof store.getEvents;

  const { setup, cleanup } = await render(100, 30, undefined, store);
  try {
    await act(async () => {
      setup.mockInput.pressArrow('down'); // move off "current" onto the stored run
    });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('Phase 0'); // its log is on screen
    const afterSelect = reads;
    expect(afterSelect).toBeGreaterThan(0);

    // Re-renders that change nothing about the selection must not re-read it.
    await act(async () => {
      await setup.mockInput.typeText('abc');
    });
    await setup.renderOnce();
    expect(reads).toBe(afterSelect);
    setup.renderer.destroy();
  } finally {
    cleanup();
  }
}, 20000);

test('settings view renders the editable workspace settings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omks-set-'));
  const ws = Workspace.init(dir);
  try {
    const setup = await testRender(
      createElement(SettingsView, { workspace: ws, providers, onClose: () => {}, width: 100 }),
      { width: 100, height: 24 },
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain('settings');
    expect(frame).toContain('Default provider');
    expect(frame).toContain('Max agents');
    expect(frame).toContain('Auto-approve');
    expect(frame).toContain('Provider order');
    expect(frame).toContain('change'); // footer hint
    setup.renderer.destroy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);

test('commands: parse + filter', () => {
  expect(parseCommand('/workflow tdd')).toEqual({ name: 'workflow', arg: 'tdd' });
  expect(parseCommand('/settings')).toEqual({ name: 'settings', arg: '' });
  expect(parseCommand('build a thing')).toBeNull();
  expect(isCommandInput('/x')).toBe(true);
  expect(isCommandInput('x')).toBe(false);
  // prefix filtering, then narrowing to the exact command once an arg is typed
  expect(filterCommands('/w').map((c) => c.name)).toEqual(['workflow']);
  expect(filterCommands('/workflow tdd').map((c) => c.name)).toEqual(['workflow']);
  expect(filterCommands('/').length).toBeGreaterThan(5);
  expect(filterCommands('/zzz')).toEqual([]);
});

test('eventLines maps events to styled lines', () => {
  const lines = eventLines([
    { runId: 'r', seq: 1, type: 'phase:started', payload: { name: 'Plan', index: 0 }, createdAt: 0 },
    {
      runId: 'r',
      seq: 2,
      type: 'agent:completed',
      payload: { callId: 'a', stepKey: 'root#0', text: 'built it', status: 'ok', providerSessionId: null, tokens: 3, costUsd: 0.01, durationMs: 5 },
      createdAt: 0,
    },
  ]);
  expect(lines[0]!.text).toContain('Plan');
  expect(lines[0]!.color).toBe(theme.accent2);
  expect(lines[1]!.text).toContain('built it');
  expect(lines[1]!.color).toBe(theme.ok);
});
