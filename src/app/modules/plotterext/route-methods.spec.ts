import { describe, it, expect } from 'vitest';
import { createRouteMethods } from './route-methods';
import { RouteBufferRegistry } from './route-buffer.registry';

function setup() {
  const registry = new RouteBufferRegistry();
  const methods = createRouteMethods(registry);
  // The bus dispatches handlers as (params, ctx); ctx is unused here.
  const call = async (name: string, params?: unknown) =>
    methods[name](params, {} as never);
  return { registry, methods, call };
}

describe('route methods (host handlers)', () => {
  it('route.create creates a buffer and returns routeId + rev', async () => {
    const { call, registry } = setup();
    const res = (await call('route.create', {
      name: 'A',
      points: [{ position: [1, 2] }]
    })) as { routeId: string; rev: number };
    expect(res.rev).toBe(1);
    expect(typeof res.routeId).toBe('string');
    expect(registry.get(res.routeId)?.name).toBe('A');
    expect(registry.get(res.routeId)?.points).toHaveLength(1);
  });

  it('route.get returns the buffer snapshot', async () => {
    const { call } = setup();
    const { routeId } = (await call('route.create', { name: 'A' })) as {
      routeId: string;
    };
    const b = await call('route.get', { routeId });
    expect(b).toMatchObject({
      routeId,
      name: 'A',
      rev: 1,
      saved: false,
      points: []
    });
  });

  it('route.list returns { routes }', async () => {
    const { call } = setup();
    await call('route.create', { name: 'A' });
    await call('route.create', { name: 'B' });
    const res = (await call('route.list')) as { routes: unknown[] };
    expect(res.routes).toHaveLength(2);
  });

  it('route.delete removes the buffer and returns {}', async () => {
    const { call, registry } = setup();
    const { routeId } = (await call('route.create')) as { routeId: string };
    const res = await call('route.delete', { routeId });
    expect(res).toEqual({});
    expect(registry.has(routeId)).toBe(false);
  });

  it('route.get on an unknown id rejects with routes.unknownId', async () => {
    const { call } = setup();
    await expect(call('route.get', { routeId: 'nope' })).rejects.toHaveProperty(
      'reason',
      'routes.unknownId'
    );
  });

  it('route.delete on an unknown id rejects with routes.unknownId', async () => {
    const { call } = setup();
    await expect(
      call('route.delete', { routeId: 'nope' })
    ).rejects.toHaveProperty('reason', 'routes.unknownId');
  });

  it('route.get without a routeId rejects', async () => {
    const { call } = setup();
    await expect(call('route.get', {})).rejects.toBeInstanceOf(Error);
  });

  it('route.replace sets points and returns the new rev', async () => {
    const { call, registry } = setup();
    const { routeId } = (await call('route.create', {
      points: [{ position: [0, 0] }]
    })) as { routeId: string };
    const res = (await call('route.replace', {
      routeId,
      points: [{ position: [1, 1] }, { position: [2, 2] }]
    })) as { rev: number };
    expect(res.rev).toBe(2);
    expect(registry.get(routeId)?.points).toHaveLength(2);
  });

  it('route.replace on an unknown id rejects with routes.unknownId', async () => {
    const { call } = setup();
    await expect(
      call('route.replace', { routeId: 'nope', points: [] })
    ).rejects.toHaveProperty('reason', 'routes.unknownId');
  });
  it('route.save delegates to onSave and returns its result', async () => {
    const registry = new RouteBufferRegistry();
    const seen: string[] = [];
    const methods = createRouteMethods(registry, {
      onSave: async (routeId) => {
        seen.push(routeId);
        return { href: 'routes/abc', rev: 5 };
      }
    });
    const { routeId } = registry.create({ name: 'A' });
    const res = await methods['route.save']({ routeId }, {} as never);
    expect(res).toEqual({ href: 'routes/abc', rev: 5 });
    expect(seen).toEqual([routeId]);
  });

  it('route.save without an onSave handler rejects routes.notSupported', async () => {
    const registry = new RouteBufferRegistry();
    const methods = createRouteMethods(registry);
    const { routeId } = registry.create();
    await expect(
      (async () => methods['route.save']({ routeId }, {} as never))()
    ).rejects.toHaveProperty('reason', 'routes.notSupported');
  });

  it('route.save on an unknown id rejects routes.unknownId', async () => {
    const registry = new RouteBufferRegistry();
    const methods = createRouteMethods(registry, {
      onSave: async () => ({ href: 'x', rev: 1 })
    });
    await expect(
      (async () => methods['route.save']({ routeId: 'nope' }, {} as never))()
    ).rejects.toHaveProperty('reason', 'routes.unknownId');
  });
});
