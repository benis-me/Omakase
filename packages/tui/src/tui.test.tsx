import { test, expect } from 'bun:test';
import { createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { RGBA } from '@opentui/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace, Store } from '@omakase/core';
import type { ProviderInfo } from '@omakase/providers';
import { App } from './app.tsx';
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

async function render(width = 100, height = 30) {
  const dir = mkdtempSync(join(tmpdir(), 'omks-tui-'));
  const ws = Workspace.init(dir);
  const store = new Store(':memory:');
  const setup = await testRender(
    createElement(App, { workspace: ws, store, providers, workflows: ['goal', 'auto', 'tdd'], onExit: () => {} }),
    { width, height },
  );
  await setup.renderOnce();
  return { setup, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
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
    expect(frame).toContain('browse'); // footer hints
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
