import { describe, expect, it } from 'vitest';
import { mapKey, type KeyCtx } from '../src/keymap.js';

const ctx = (over: Partial<KeyCtx> = {}): KeyCtx => ({
  leaderArmed: false, bashMode: false, overlayOpen: false, runActive: false, ...over,
});

describe('mapKey', () => {
  it('maps the core control bindings', () => {
    expect(mapKey({ name: 'p', ctrl: true }, ctx())).toEqual({ type: 'palette' });
    expect(mapKey({ name: 'x', ctrl: true }, ctx())).toEqual({ type: 'arm-leader' });
    expect(mapKey({ name: 'n', ctrl: true }, ctx())).toEqual({ type: 'cycle-agent', dir: 1 });
    expect(mapKey({ name: 'o', ctrl: true }, ctx())).toEqual({ type: 'toggle-detail' });
    expect(mapKey({ name: 'tab', shift: true }, ctx())).toEqual({ type: 'cycle-mode' });
    expect(mapKey({ name: 'pageup' }, ctx())).toEqual({ type: 'scroll', by: -10 });
  });

  it('resolves leader sequences when armed', () => {
    expect(mapKey({ name: 'l' }, ctx({ leaderArmed: true }))).toEqual({ type: 'sessions' });
    expect(mapKey({ name: 'n' }, ctx({ leaderArmed: true }))).toEqual({ type: 'new-session' });
    expect(mapKey({ name: 'z' }, ctx({ leaderArmed: true }))).toEqual({ type: 'none' });
  });

  it('escape: exit bash > interrupt run > nothing; overlay swallows keys', () => {
    expect(mapKey({ name: 'escape' }, ctx({ bashMode: true }))).toEqual({ type: 'exit-bash' });
    expect(mapKey({ name: 'escape' }, ctx({ runActive: true }))).toEqual({ type: 'interrupt' });
    expect(mapKey({ name: 'escape' }, ctx())).toEqual({ type: 'none' });
    expect(mapKey({ name: 'escape' }, ctx({ overlayOpen: true }))).toEqual({ type: 'close-overlay' });
    expect(mapKey({ name: 'p', ctrl: true }, ctx({ overlayOpen: true }))).toEqual({ type: 'none' });
  });
});
