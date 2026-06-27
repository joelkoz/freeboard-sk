import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/**
 * Position tuple `[lon, lat, alt?]`. Structurally identical to the app-wide
 * `Position` type (src/app/types); kept local so this registry stays
 * self-contained and unit-testable in isolation.
 */
export type RoutePosition = [number, number, number?];

/** A single point in a live route edit buffer. */
export interface RoutePoint {
  position: RoutePosition;
  name?: string;
  description?: string;
}

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

/** Summary entry returned by `list()`. */
export interface RouteBufferSummary {
  routeId: string;
  name: string | null;
  rev: number;
  pointCount: number;
  saved: boolean;
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
  list(): RouteBufferSummary[] {
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
    this.events.next({ type: 'deleted', routeId, rev: b.rev });
    return true;
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
      position: [...p.position] as RoutePosition,
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
