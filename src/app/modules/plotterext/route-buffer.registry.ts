import { Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { RoutePoint, RouteSummary } from 'signalk-plotterext-bus/host';

/**
 * A live, in-memory route edit buffer. Not necessarily persisted: a buffer is
 * a route the host is currently holding/rendering, addressed by a host-assigned
 * `routeId`, that may never be saved (persistence is opt-in elsewhere).
 */
export interface RouteBuffer {
  routeId: string;
  name: string | null;
  /** Monotonic revision; increments on every mutation. */
  rev: number;
  /** Whether the buffer has been persisted to the routes resource collection. */
  saved: boolean;
  points: RoutePoint[];
}

/**
 * A registry mutation, surfaced on `events$`. The host bridges these to the
 * `route.*` bus events of the plotter-extensions `routes` capability. Point
 * mutations (`route.point.*`) extend this union in a later slice; `dirty` is
 * the conformance-floor catch-all.
 */
export type RouteRegistryEvent =
  | {
      type: 'created';
      routeId: string;
      rev: number;
      name: string | null;
      pointCount: number;
    }
  | { type: 'deleted'; routeId: string; rev: number }
  | { type: 'dirty'; routeId: string; rev: number; reason?: string };

/**
 * Holds the host's live route edit buffers. The single source of truth for
 * routes being built or edited via the `routes` capability: extensions CRUD
 * buffers through it, native draw/modify gestures feed it, and it renders them
 * on the chart. This service owns the data + the `rev` contract and emits
 * mutation events; wiring to the bus and the map layer lives elsewhere.
 */
@Injectable({ providedIn: 'root' })
export class RouteBufferRegistry {
  private readonly buffers = new Map<string, RouteBuffer>();
  private readonly events = new Subject<RouteRegistryEvent>();

  /** Stream of buffer mutations (created / deleted / dirty). */
  readonly events$: Observable<RouteRegistryEvent> = this.events.asObservable();

  private readonly liveSignal = signal<RouteBuffer[]>([]);
  /** Reactive snapshot of all live buffers, for chart rendering. */
  readonly live = this.liveSignal.asReadonly();

  /** Create a new buffer, optionally seeded with a name and/or points. */
  create(opts: { name?: string; points?: RoutePoint[] } = {}): RouteBuffer {
    const routeId = this.newRouteId();
    const buffer: RouteBuffer = {
      routeId,
      name: opts.name ?? null,
      rev: 1,
      saved: false,
      points: (opts.points ?? []).map((p) => this.clonePoint(p))
    };
    this.buffers.set(routeId, buffer);
    this.refreshLive();
    this.events.next({
      type: 'created',
      routeId,
      rev: buffer.rev,
      name: buffer.name,
      pointCount: buffer.points.length
    });
    return this.snapshot(buffer);
  }

  /** Snapshot of a buffer, or undefined if no buffer has that id. */
  get(routeId: string): RouteBuffer | undefined {
    const b = this.buffers.get(routeId);
    return b ? this.snapshot(b) : undefined;
  }

  /** Whether a buffer with the given id exists. */
  has(routeId: string): boolean {
    return this.buffers.has(routeId);
  }

  /** Summaries of all live buffers. */
  list(): RouteSummary[] {
    return [...this.buffers.values()].map((b) => ({
      routeId: b.routeId,
      name: b.name,
      rev: b.rev,
      pointCount: b.points.length,
      saved: b.saved
    }));
  }

  /** Discard a buffer. Returns true if it existed. Emits `deleted`. */
  delete(routeId: string): boolean {
    const b = this.buffers.get(routeId);
    if (!b) {
      return false;
    }
    b.rev += 1;
    this.buffers.delete(routeId);
    this.refreshLive();
    this.events.next({ type: 'deleted', routeId, rev: b.rev });
    return true;
  }

  /**
   * Replace all points of a buffer (bulk set). Returns the updated snapshot, or
   * undefined if no buffer has that id. Emits a `dirty` event (reason
   * `replaced`) — the auto-router's primary write path.
   */
  replace(routeId: string, points: RoutePoint[]): RouteBuffer | undefined {
    const b = this.buffers.get(routeId);
    if (!b) {
      return undefined;
    }
    b.points = (points ?? []).map((p) => this.clonePoint(p));
    b.rev += 1;
    this.refreshLive();
    this.events.next({
      type: 'dirty',
      routeId,
      rev: b.rev,
      reason: 'replaced'
    });
    return this.snapshot(b);
  }

  private refreshLive(): void {
    this.liveSignal.set(
      [...this.buffers.values()].map((b) => this.snapshot(b))
    );
  }

  /**
   * Re-emit the live() signal without changing any buffer. Used to force a
   * chart re-render — e.g. to restore a draft's geometry after the user
   * cancels an in-place edit (the map feature was moved by the Modify
   * interaction but the registry was never updated).
   */
  refresh(): void {
    this.refreshLive();
  }

  private newRouteId(): string {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) {
      return c.randomUUID();
    }
    // Fallback for environments without WebCrypto randomUUID.
    return (
      'rb-' +
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }

  private clonePoint(p: RoutePoint): RoutePoint {
    return {
      position: [...p.position] as RoutePoint['position'],
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.description !== undefined ? { description: p.description } : {})
    };
  }

  /** Defensive copy so callers cannot mutate registry internals. */
  private snapshot(b: RouteBuffer): RouteBuffer {
    return {
      routeId: b.routeId,
      name: b.name,
      rev: b.rev,
      saved: b.saved,
      points: b.points.map((p) => this.clonePoint(p))
    };
  }
}
