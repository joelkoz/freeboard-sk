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
 * Point operations, replace/rename and save extend this surface in later slices.
 */
export function createRouteMethods(
  registry: RouteBufferRegistry
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
