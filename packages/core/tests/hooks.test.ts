import { describe, expect, it } from 'vitest';
import { HookBus } from '../src/hooks/bus.js';
import type { OrchestrationHooks } from '../src/hooks/types.js';

describe('HookBus', () => {
  it('runs handlers in priority then registration order', async () => {
    const bus = new HookBus<{ tick: { log: string[] } }>();
    const log: string[] = [];
    bus.on('tick', () => void log.push('a'), { priority: 0 });
    bus.on('tick', () => void log.push('b'), { priority: 10 });
    bus.on('tick', () => void log.push('c'), { priority: 0 });
    await bus.emit('tick', { log });
    expect(log).toEqual(['b', 'a', 'c']);
  });

  it('awaits async handlers sequentially', async () => {
    const bus = new HookBus<{ tick: undefined }>();
    const order: number[] = [];
    bus.on('tick', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
    });
    bus.on('tick', () => void order.push(2));
    await bus.emit('tick', undefined);
    expect(order).toEqual([1, 2]);
  });

  it('rethrows under failureMode "throw" and stops', async () => {
    const bus = new HookBus<{ tick: undefined }>();
    const ran: string[] = [];
    bus.on('tick', () => {
      ran.push('first');
      throw new Error('boom');
    });
    bus.on('tick', () => void ran.push('second'));
    await expect(bus.emit('tick', undefined, { failureMode: 'throw' })).rejects.toThrow('boom');
    expect(ran).toEqual(['first']);
  });

  it('continues and reports errors under failureMode "continue"', async () => {
    const bus = new HookBus<{ tick: undefined }>();
    const ran: string[] = [];
    const errors: unknown[] = [];
    bus.on('tick', () => {
      throw new Error('boom');
    });
    bus.on('tick', () => void ran.push('second'));
    await bus.emit('tick', undefined, { onError: (e) => errors.push(e) });
    expect(ran).toEqual(['second']);
    expect(errors).toHaveLength(1);
  });

  it('supports removal via handle and off()', async () => {
    const bus = new HookBus<{ tick: undefined }>();
    const ran: string[] = [];
    const handle = bus.on('tick', () => void ran.push('x'));
    const handler = (): void => void ran.push('y');
    bus.on('tick', handler);
    handle.remove();
    bus.off('tick', handler);
    expect(bus.count('tick')).toBe(0);
    await bus.emit('tick', undefined);
    expect(ran).toEqual([]);
  });

  it('is usable with the OrchestrationHooks map', async () => {
    const bus = new HookBus<OrchestrationHooks>();
    const seen: string[] = [];
    bus.on('beforeRoute', ({ request }) => void seen.push(request.prompt));
    await bus.emit('beforeRoute', { request: { prompt: 'hi' } });
    expect(seen).toEqual(['hi']);
  });
});
