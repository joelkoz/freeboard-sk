import {
  RPC_ERRORS,
  RpcError,
  type MethodHandler,
  type RoutePoint
} from 'signalk-plotterext-bus/host';
import { RouteBufferRegistry } from './route-buffer.registry';

/**
 * Host method handlers for the `routes` capability (Slice 0 surface:
 * list/create/get/delete). A pure factory over a {@link RouteBufferRegistry},
 * so the handlers are unit-testable without the Angular host service; the
 * service spreads the result into each extension context's method table
 * (matching the existing `stateMethods` / `resourcesMethods` pattern).
 *
 * Point operations and rename extend this surface in later slices.
 */

/**
 * Persist a buffer to the routes resource. The host owns the UX (e.g. a naming
 * dialog) and the server write; resolves with the stored resource href. Injected
 * because persistence is host-specific (the registry is pure data).
 */
export type RouteSaveHandler = (
  routeId: string,
  params: { name?: string; description?: string }
) => Promise<{ href: string; rev: number } | null>;

export function createRouteMethods(
  registry: RouteBufferRegistry,
  opts: { onSave?: RouteSaveHandler } = {}
): Record<string, MethodHandler> {
  const requireRouteId = (params: unknown): string => {
    const routeId = (params as { routeId?: unknown } | null)?.routeId;
    if (typeof routeId !== 'string' || routeId.length === 0) {
      throw new RpcError('route method requires a routeId', {
        code: RPC_ERRORS.INVALID_PARAMS,
        reason: 'routes.badRequest'
      });
    }
    return routeId;
  };

  const unknownId = () =>
    new RpcError('Unknown route buffer', { reason: 'routes.unknownId' });

  return {
    'route.list': () => ({ routes: registry.list() }),

    'route.create': (params) => {
      const { name, points } = (params ?? {}) as {
        name?: string;
        points?: RoutePoint[];
      };
      const buffer = registry.create({ name, points });
      return { routeId: buffer.routeId, rev: buffer.rev };
    },

    'route.replace': (params) => {
      const routeId = requireRouteId(params);
      const { points } = (params ?? {}) as { points?: RoutePoint[] };
      const updated = registry.replace(routeId, points ?? []);
      if (!updated) {
        throw unknownId();
      }
      return { rev: updated.rev };
    },

    'route.save': async (params) => {
      const routeId = requireRouteId(params);
      if (!registry.has(routeId)) {
        throw unknownId();
      }
      if (!opts.onSave) {
        throw new RpcError('This host cannot persist routes', {
          reason: 'routes.notSupported'
        });
      }
      const { name, description } = (params ?? {}) as {
        name?: string;
        description?: string;
      };
      const result = await opts.onSave(routeId, { name, description });
      if (!result) {
        throw new RpcError('Route save was cancelled', {
          reason: 'routes.saveCancelled'
        });
      }
      return result;
    },

    'route.get': (params) => {
      const buffer = registry.get(requireRouteId(params));
      if (!buffer) {
        throw unknownId();
      }
      return buffer;
    },

    'route.delete': (params) => {
      if (!registry.delete(requireRouteId(params))) {
        throw unknownId();
      }
      return {};
    }
  };
}
