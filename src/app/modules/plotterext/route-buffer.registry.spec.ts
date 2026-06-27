import { describe, it, expect } from 'vitest';
import {
  RouteBufferRegistry,
  RouteRegistryEvent
} from './route-buffer.registry';

describe('RouteBufferRegistry', () => {
  it('creates a buffer with rev 1 and returns it via get', () => {
    const reg = new RouteBufferRegistry();
    const { routeId, rev } = reg.create({
      name: 'Test',
      points: [{ position: [-80.1, 25.7] }]
    });
    expect(rev).toBe(1);
    const b = reg.get(routeId);
    expect(b?.name).toBe('Test');
    expect(b?.rev).toBe(1);
    expect(b?.saved).toBe(false);
    expect(b?.points).toHaveLength(1);
    expect(b?.points[0].position).toEqual([-80.1, 25.7]);
  });

  it('defaults name to null and points to empty', () => {
    const reg = new RouteBufferRegistry();
    const { routeId } = reg.create();
    const b = reg.get(routeId);
    expect(b?.name).toBeNull();
    expect(b?.points).toEqual([]);
  });

  it('lists all live buffers as summaries', () => {
    const reg = new RouteBufferRegistry();
    const a = reg.create({ name: 'A' });
    const b = reg.create({ name: 'B' });
    const ids = reg
      .list()
      .map((s) => s.routeId)
      .sort();
    expect(ids).toEqual([a.routeId, b.routeId].sort());
    const sumA = reg.list().find((s) => s.routeId === a.routeId);
    expect(sumA).toMatchObject({
      name: 'A',
      rev: 1,
      pointCount: 0,
      saved: false
    });
  });

  it('returns undefined for an unknown id and false when deleting it', () => {
    const reg = new RouteBufferRegistry();
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.has('nope')).toBe(false);
    expect(reg.delete('nope')).toBe(false);
  });

  it('deletes a buffer, removing it from get and list', () => {
    const reg = new RouteBufferRegistry();
    const { routeId } = reg.create({ name: 'X' });
    expect(reg.delete(routeId)).toBe(true);
    expect(reg.get(routeId)).toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  it('assigns a unique id to each buffer', () => {
    const reg = new RouteBufferRegistry();
    const a = reg.create();
    const b = reg.create();
    expect(a.routeId).not.toBe(b.routeId);
  });

  it('emits created then deleted with a monotonic rev', () => {
    const reg = new RouteBufferRegistry();
    const seen: RouteRegistryEvent[] = [];
    reg.events$.subscribe((e) => seen.push(e));
    const { routeId } = reg.create({
      name: 'X',
      points: [{ position: [0, 0] }]
    });
    reg.delete(routeId);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      type: 'created',
      routeId,
      rev: 1,
      name: 'X',
      pointCount: 1
    });
    expect(seen[1]).toMatchObject({ type: 'deleted', routeId, rev: 2 });
  });

  it('snapshots defensively — mutating a returned buffer does not affect the registry', () => {
    const reg = new RouteBufferRegistry();
    const { routeId } = reg.create({ points: [{ position: [1, 2] }] });
    const b = reg.get(routeId)!;
    b.points[0].position[0] = 999;
    b.points.push({ position: [3, 4] });
    const fresh = reg.get(routeId)!;
    expect(fresh.points).toHaveLength(1);
    expect(fresh.points[0].position[0]).toBe(1);
  });
});
