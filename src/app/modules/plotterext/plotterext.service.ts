// Plotter extension host service.
//
// Responsibilities (phase 1-2 of the plotterExtensions host implementation —
// the widget stack):
//   - discover extension manifests from /signalk/v2/api/resources/plotterExtensions
//   - per-extension enable/disable + widget placement persisted in app config
//   - one HostConnection (signalk-plotterext-bus) per live iframe context
//   - host API methods: state.get/set, signalk.subscribe/unsubscribe/put,
//     ui.openConfigPanel, ui.closePanel
//   - a single multiplexed delta WebSocket relaying subscribed Signal K paths
//     to widget contexts as sk.<path> events
//
// Map/resource host APIs (buttons, filters, map.*) belong to phase 3.

import { Injectable, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { SignalKClient } from 'signalk-client-angular';

import { AppFacade } from 'src/app/app.facade';
import {
  HostConnection,
  MethodHandler,
  RpcError,
  RPC_ERRORS,
  windowPort
} from 'signalk-plotterext-bus/host';
import {
  Corner,
  ExtensionInfo,
  HOST_API_VERSION,
  HOST_CAPABILITIES,
  PanelContribution,
  PlacedWidget,
  PlotterExtensionManifest,
  WidgetContribution,
  parseSize
} from './types';

const STATE_STORAGE_KEY = 'fb-plotterext-state';
const SK_PATH_PERIOD = 1000; // default delta period (ms) for relayed paths

interface ExtensionStateStore {
  [extensionId: string]: {
    extension?: Record<string, unknown>;
    instances?: { [instanceId: string]: Record<string, unknown> };
  };
}

interface LiveContext {
  extension: string;
  conn: HostConnection;
  /** signalk.subscribe subscriptionId -> paths */
  skSubs: Map<string, string[]>;
  skSubSeq: number;
}

@Injectable({ providedIn: 'root' })
export class PlotterExtensionService {
  // id -> manifest, as discovered from the resources API
  readonly manifests = signal<Record<string, PlotterExtensionManifest>>({});
  // placements of currently-enabled extensions (drives the overlay)
  readonly activeWidgets = signal<PlacedWidget[]>([]);
  readonly initialized = signal(false);

  private contexts = new Set<LiveContext>();

  // ---- Signal K delta relay (one WS for all widget contexts) ----
  private ws: WebSocket | null = null;
  private wsReady = false;
  private pathRefs = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private app: AppFacade,
    private signalk: SignalKClient,
    private dialog: MatDialog
  ) {}

  /** Fetch manifests. Called after the server connection is established. */
  async init(): Promise<void> {
    try {
      const response = await firstValueFrom(
        this.signalk.api.get(this.app.skApiVersion, '/resources/plotterExtensions')
      );
      const manifests: Record<string, PlotterExtensionManifest> = {};
      if (response && typeof response === 'object') {
        for (const [id, value] of Object.entries(
          response as Record<string, unknown>
        )) {
          if (this.isManifest(value)) {
            manifests[id] = value as PlotterExtensionManifest;
          }
        }
      }
      this.manifests.set(manifests);
    } catch {
      // No provider installed (404) or fetch failed: extensions unavailable.
      this.manifests.set({});
    }
    this.refreshActiveWidgets();
    this.initialized.set(true);
  }

  // ---------- discovery / enablement ----------

  extensions(): ExtensionInfo[] {
    const enabled = this.app.config.plotterExtensions.enabled;
    return Object.entries(this.manifests()).map(([id, manifest]) => {
      const compat = this.checkCompatible(manifest);
      return {
        id,
        manifest,
        compatible: compat.ok,
        incompatibleReason: compat.reason,
        enabled: enabled.includes(id)
      };
    });
  }

  isEnabled(id: string): boolean {
    return this.app.config.plotterExtensions.enabled.includes(id);
  }

  setEnabled(id: string, enabled: boolean) {
    const list = this.app.config.plotterExtensions.enabled;
    const idx = list.indexOf(id);
    if (enabled && idx === -1) {
      list.push(id);
    } else if (!enabled && idx !== -1) {
      list.splice(idx, 1);
    }
    this.app.saveConfig();
    this.refreshActiveWidgets();
  }

  private checkCompatible(manifest: PlotterExtensionManifest): {
    ok: boolean;
    reason?: string;
  } {
    if (manifest.apiVersion !== HOST_API_VERSION) {
      return {
        ok: false,
        reason: `requires extension API version ${manifest.apiVersion}`
      };
    }
    const missing = (manifest.requires ?? []).filter(
      (cap) => !HOST_CAPABILITIES.includes(cap)
    );
    if (missing.length) {
      return { ok: false, reason: `requires: ${missing.join(', ')}` };
    }
    return { ok: true };
  }

  private isManifest(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as PlotterExtensionManifest).name === 'string' &&
      typeof (value as PlotterExtensionManifest).apiVersion === 'string'
    );
  }

  // ---------- widget placement ----------

  widgetDef(extension: string, widget: string): WidgetContribution | null {
    const manifest = this.manifests()[extension];
    return manifest?.widgets?.find((w) => w.id === widget) ?? null;
  }

  /** Widgets of an extension placeable by this host (apiVersion gate). */
  placeableWidgets(extension: string): WidgetContribution[] {
    const manifest = this.manifests()[extension];
    return (manifest?.widgets ?? []).filter(
      (w) =>
        w.type === 'iframe' &&
        (w.apiVersion === undefined || w.apiVersion === HOST_API_VERSION)
    );
  }

  placements(): PlacedWidget[] {
    return this.app.config.plotterExtensions.widgets;
  }

  /**
   * Place a widget in the first free cells of the requested corner.
   * Returns the new placement, or null when the widget does not fit.
   */
  placeWidget(
    extension: string,
    widget: WidgetContribution,
    corner: Corner
  ): PlacedWidget | null {
    const { cols, rows } = parseSize(widget.size);
    const origin = this.findFreeOrigin(corner, cols, rows);
    if (!origin) return null;
    const placed: PlacedWidget = {
      instanceId: crypto.randomUUID(),
      extension,
      widget: widget.id,
      corner,
      col: origin.col,
      row: origin.row
    };
    this.app.config.plotterExtensions.widgets.push(placed);
    this.app.saveConfig();
    this.refreshActiveWidgets();
    return placed;
  }

  removeWidget(instanceId: string) {
    const widgets = this.app.config.plotterExtensions.widgets;
    const idx = widgets.findIndex((w) => w.instanceId === instanceId);
    if (idx !== -1) {
      const [removed] = widgets.splice(idx, 1);
      this.clearInstanceState(removed.extension, instanceId);
      this.app.saveConfig();
      this.refreshActiveWidgets();
    }
  }

  private findFreeOrigin(
    corner: Corner,
    cols: number,
    rows: number
  ): { col: number; row: number } | null {
    const occupied = [
      [false, false],
      [false, false]
    ];
    for (const placed of this.placements()) {
      if (placed.corner !== corner) continue;
      const def = this.widgetDef(placed.extension, placed.widget);
      const size = parseSize(def?.size ?? '1x1');
      for (let r = placed.row; r < placed.row + size.rows && r < 2; r++) {
        for (let c = placed.col; c < placed.col + size.cols && c < 2; c++) {
          occupied[r][c] = true;
        }
      }
    }
    for (let row = 0; row + rows <= 2; row++) {
      for (let col = 0; col + cols <= 2; col++) {
        let free = true;
        for (let r = row; r < row + rows; r++) {
          for (let c = col; c < col + cols; c++) {
            if (occupied[r][c]) free = false;
          }
        }
        if (free) return { col, row };
      }
    }
    return null;
  }

  private refreshActiveWidgets() {
    const manifests = this.manifests();
    const enabled = this.app.config.plotterExtensions.enabled;
    this.activeWidgets.set(
      this.placements().filter(
        (p) =>
          enabled.includes(p.extension) &&
          manifests[p.extension]?.widgets?.some((w) => w.id === p.widget)
      )
    );
  }

  // ---------- live contexts (one per iframe) ----------

  /**
   * Manifest asset URLs are server-relative; resolve them against the
   * Signal K server origin (which differs from the app origin when running
   * the Angular dev server).
   */
  resolveAssetUrl(url: string): string {
    const base = this.app.hostDef?.url || window.location.origin;
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

  private assetOrigin(url: string): string {
    try {
      return new URL(this.resolveAssetUrl(url)).origin;
    } catch {
      return '*';
    }
  }

  /**
   * Attach a widget iframe to the host. Returns a detach function.
   * Call once the iframe element exists (the connection handles the
   * extension's bus.ready retries, so load-order does not matter).
   */
  attachWidget(iframe: HTMLIFrameElement, placed: PlacedWidget): () => void {
    const ctx: LiveContext = {
      extension: placed.extension,
      conn: null as unknown as HostConnection,
      skSubs: new Map(),
      skSubSeq: 0
    };
    const widgetUrl = this.widgetDef(placed.extension, placed.widget)?.url ?? '';
    ctx.conn = new HostConnection({
      port: windowPort(iframe.contentWindow as Window, {
        origin: this.assetOrigin(widgetUrl)
      }),
      hostInfo: this.hostInfo(),
      context: {
        kind: 'widget',
        id: placed.widget,
        instanceId: placed.instanceId,
        targetInstance: null
      },
      methods: {
        ...this.stateMethods(placed.extension, placed.instanceId),
        ...this.signalkMethods(ctx),
        'ui.openConfigPanel': async () => {
          this.openConfigPanel(placed);
          return {};
        }
      },
      onError: (err) => console.warn('plotterext widget error', err)
    });
    this.contexts.add(ctx);
    return () => this.detach(ctx);
  }

  /**
   * Attach a panel iframe (e.g. a widget configuration panel). targetInstance
   * scopes the panel's instance state to the widget being configured.
   */
  attachPanel(
    iframe: HTMLIFrameElement,
    opts: {
      extension: string;
      panel: PanelContribution;
      targetInstance?: string | null;
      targetWidget?: string | null;
      close: () => void;
    }
  ): () => void {
    const ctx: LiveContext = {
      extension: opts.extension,
      conn: null as unknown as HostConnection,
      skSubs: new Map(),
      skSubSeq: 0
    };
    ctx.conn = new HostConnection({
      port: windowPort(iframe.contentWindow as Window, {
        origin: this.assetOrigin(opts.panel.url ?? '')
      }),
      hostInfo: this.hostInfo(),
      context: {
        kind: 'panel',
        id: opts.panel.id,
        instanceId: null,
        targetInstance: opts.targetInstance ?? null,
        targetWidget: opts.targetWidget ?? null
      },
      methods: {
        ...this.stateMethods(opts.extension, opts.targetInstance ?? null),
        ...this.signalkMethods(ctx),
        'ui.closePanel': async () => {
          opts.close();
          return {};
        }
      },
      onError: (err) => console.warn('plotterext panel error', err)
    });
    this.contexts.add(ctx);
    return () => this.detach(ctx);
  }

  private detach(ctx: LiveContext) {
    if (!this.contexts.has(ctx)) return;
    this.contexts.delete(ctx);
    for (const [, paths] of ctx.skSubs) {
      this.releasePaths(paths);
    }
    ctx.skSubs.clear();
    ctx.conn.close();
  }

  private hostInfo() {
    return {
      host: 'freeboard-sk',
      hostVersion: this.app.data?.server?.version ?? 'dev',
      apiVersion: HOST_API_VERSION,
      capabilities: HOST_CAPABILITIES
    };
  }

  // ---------- configuration panels ----------

  openConfigPanel(placed: PlacedWidget) {
    const manifest = this.manifests()[placed.extension];
    const widget = this.widgetDef(placed.extension, placed.widget);
    const panel = manifest?.panels?.find((p) => p.id === widget?.configPanel);
    if (!panel || panel.type !== 'iframe' || !panel.url) {
      this.app.showMessage('This widget has no configuration panel.');
      return;
    }
    // Deferred import avoids a service->component->service import cycle.
    import('./panel-dialog.component').then(({ PlotterPanelDialog }) => {
      this.dialog.open(PlotterPanelDialog, {
        data: {
          extension: placed.extension,
          panel,
          targetInstance: placed.instanceId,
          targetWidget: placed.widget
        },
        width: '440px',
        maxHeight: '85vh'
      });
    });
  }

  // ---------- state storage ----------
  //
  // v0 persistence is browser localStorage. TODO(phase 2 follow-up): persist
  // through the server's applicationData so widget config follows the user
  // across devices, mirroring how Freeboard persists its own config.

  private loadStore(): ExtensionStateStore {
    try {
      return JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  private saveStore(store: ExtensionStateStore) {
    localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(store));
  }

  private clearInstanceState(extension: string, instanceId: string) {
    const store = this.loadStore();
    if (store[extension]?.instances?.[instanceId]) {
      delete store[extension].instances![instanceId];
      this.saveStore(store);
    }
  }

  private stateMethods(
    extension: string,
    instanceId: string | null
  ): Record<string, MethodHandler> {
    const resolve = (
      store: ExtensionStateStore,
      scope: string | undefined
    ): Record<string, unknown> => {
      const extStore = (store[extension] = store[extension] ?? {});
      const useInstance = (scope ?? (instanceId ? 'instance' : 'extension')) === 'instance';
      if (useInstance) {
        if (!instanceId) {
          throw new RpcError('No widget instance in scope', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'NO_INSTANCE'
          });
        }
        extStore.instances = extStore.instances ?? {};
        return (extStore.instances[instanceId] =
          extStore.instances[instanceId] ?? {});
      }
      return (extStore.extension = extStore.extension ?? {});
    };

    return {
      'state.get': async (params) => {
        const { scope, keys } = (params ?? {}) as {
          scope?: string;
          keys?: string[];
        };
        const values = resolve(this.loadStore(), scope);
        if (!keys) return { values };
        const filtered: Record<string, unknown> = {};
        for (const key of keys) {
          if (key in values) filtered[key] = values[key];
        }
        return { values: filtered };
      },
      'state.set': async (params) => {
        const { scope, values } = (params ?? {}) as {
          scope?: string;
          values?: Record<string, unknown>;
        };
        if (!values || typeof values !== 'object') {
          throw new RpcError('state.set requires a values object', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'INVALID_VALUES'
          });
        }
        const store = this.loadStore();
        const target = resolve(store, scope);
        Object.assign(target, values);
        this.saveStore(store);
        const useInstance =
          (scope ?? (instanceId ? 'instance' : 'extension')) === 'instance';
        this.publishToExtension(extension, 'state.changed', {
          scope: useInstance ? 'instance' : 'extension',
          instanceId: useInstance ? instanceId : null,
          keys: Object.keys(values)
        });
        return {};
      }
    };
  }

  private publishToExtension(extension: string, event: string, params: unknown) {
    for (const ctx of this.contexts) {
      if (ctx.extension === extension) {
        ctx.conn.publish(event, params);
      }
    }
  }

  // ---------- Signal K relay ----------

  private signalkMethods(ctx: LiveContext): Record<string, MethodHandler> {
    return {
      'signalk.subscribe': async (params) => {
        const { paths } = (params ?? {}) as { paths?: unknown };
        if (
          !Array.isArray(paths) ||
          paths.length === 0 ||
          !paths.every(
            (p) => typeof p === 'string' && p.length > 0 && !p.includes('*')
          )
        ) {
          throw new RpcError(
            'signalk.subscribe requires an array of literal Signal K paths',
            { code: RPC_ERRORS.INVALID_PARAMS, reason: 'INVALID_PATHS' }
          );
        }
        const subscriptionId = `sk-${++ctx.skSubSeq}`;
        ctx.skSubs.set(subscriptionId, paths as string[]);
        this.acquirePaths(paths as string[]);
        return { subscriptionId };
      },
      'signalk.unsubscribe': async (params) => {
        const { subscriptionId } = (params ?? {}) as {
          subscriptionId?: string;
        };
        const paths = subscriptionId ? ctx.skSubs.get(subscriptionId) : null;
        if (!paths) {
          throw new RpcError('Unknown subscriptionId', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'UNKNOWN_SUBSCRIPTION'
          });
        }
        ctx.skSubs.delete(subscriptionId as string);
        this.releasePaths(paths);
        return {};
      },
      'signalk.put': async (params) => {
        const { path, value } = (params ?? {}) as {
          path?: string;
          value?: unknown;
        };
        if (typeof path !== 'string' || !path.length) {
          throw new RpcError('signalk.put requires a path', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'INVALID_PATH'
          });
        }
        try {
          const result = await firstValueFrom(
            this.signalk.api.put(
              1,
              `vessels/self/${path.split('.').join('/')}`,
              value
            )
          );
          return result ?? {};
        } catch (err) {
          throw new RpcError(`PUT ${path} failed`, {
            reason: 'PUT_FAILED',
            data: { message: (err as Error)?.message }
          });
        }
      }
    };
  }

  private acquirePaths(paths: string[]) {
    const fresh: string[] = [];
    for (const path of paths) {
      const count = this.pathRefs.get(path) ?? 0;
      this.pathRefs.set(path, count + 1);
      if (count === 0) fresh.push(path);
    }
    if (fresh.length) {
      this.ensureSocket();
      this.sendSubscribe(fresh);
    }
  }

  private releasePaths(paths: string[]) {
    const gone: string[] = [];
    for (const path of paths) {
      const count = this.pathRefs.get(path) ?? 0;
      if (count <= 1) {
        this.pathRefs.delete(path);
        gone.push(path);
      } else {
        this.pathRefs.set(path, count - 1);
      }
    }
    if (gone.length && this.wsReady) {
      this.wsSend({
        context: 'vessels.self',
        unsubscribe: gone.map((path) => ({ path }))
      });
    }
    if (this.pathRefs.size === 0) {
      this.closeSocket();
    }
  }

  private ensureSocket() {
    if (this.ws) return;
    const endpoint = this.app.data?.server
      ? this.signalk.server?.endpoints?.['v1']?.['signalk-ws']
      : null;
    if (!endpoint) {
      console.warn('plotterext: no signalk-ws endpoint available');
      return;
    }
    let url = `${endpoint}?subscribe=none`;
    const token = this.app.getFBToken();
    if (token) {
      url += `&token=${token}`;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.wsReady = true;
      const paths = [...this.pathRefs.keys()];
      if (paths.length) this.sendSubscribe(paths);
    };
    ws.onmessage = (ev) => this.handleDelta(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.wsReady = false;
      if (this.pathRefs.size && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.ensureSocket();
        }, 3000);
      }
    };
    ws.onerror = () => {
      // onclose follows; reconnection handled there.
    };
  }

  private closeSocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.wsReady = false;
    ws?.close();
  }

  private sendSubscribe(paths: string[]) {
    if (!this.wsReady) return;
    this.wsSend({
      context: 'vessels.self',
      subscribe: paths.map((path) => ({
        path,
        period: SK_PATH_PERIOD,
        policy: 'instant',
        minPeriod: 200
      }))
    });
  }

  private wsSend(msg: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleDelta(raw: unknown) {
    let delta: {
      updates?: Array<{
        timestamp?: string;
        $source?: string;
        source?: { label?: string };
        values?: Array<{ path: string; value: unknown }>;
      }>;
    };
    try {
      delta = JSON.parse(raw as string);
    } catch {
      return;
    }
    if (!Array.isArray(delta.updates)) return;
    for (const update of delta.updates) {
      if (!Array.isArray(update.values)) continue;
      for (const pv of update.values) {
        if (!pv?.path || !this.pathRefs.has(pv.path)) continue;
        const event = {
          path: pv.path,
          value: pv.value,
          timestamp: update.timestamp,
          $source: update.$source ?? update.source?.label
        };
        for (const ctx of this.contexts) {
          ctx.conn.publish(`sk.${pv.path}`, event);
        }
      }
    }
  }
}
