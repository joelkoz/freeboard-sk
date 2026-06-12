// Plotter extension host service.
//
// Responsibilities (phase 1-2 of the plotterExtensions host implementation —
// the widget stack):
//   - discover extension manifests from /signalk/v2/api/resources/plotterExtensions
//   - widget placement persisted in app config (anchor areas, gravity packing)
//   - one HostConnection (signalk-plotterext-bus) per live iframe context
//   - host API methods: state.get/set, signalk.subscribe/unsubscribe/put,
//     ui.openConfigPanel, ui.closePanel
//   - a single multiplexed delta WebSocket relaying subscribed Signal K paths
//     to widget contexts as sk.<path> events
//
// There is deliberately NO host-side enable/disable for extensions: the user
// already controls extension availability on the Signal K server (plugin
// install + plugin enable). Presence in the plotterExtensions resource
// collection is the enablement signal.
//
// Map/resource host APIs (buttons, filters, map.*) belong to phase 3.

import { Injectable, computed, isDevMode, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { SignalKClient } from 'signalk-client-angular';
import { transformExtent } from 'ol/proj';

import { AppFacade } from 'src/app/app.facade';
import { SKResourceService } from 'src/app/modules/skresources/resources.service';
import { MapService } from 'src/app/modules/map/ol/lib/map.service';
import { FBNotes } from 'src/app/types';
import {
  HostConnection,
  MethodHandler,
  RpcError,
  RPC_ERRORS,
  windowPort
} from 'signalk-plotterext-bus/host';
import {
  ANCHOR_COL_ORDER,
  ANCHOR_GRAVITY,
  AnchorId,
  ButtonContribution,
  HOST_API_VERSION,
  HOST_CAPABILITIES,
  PanelContribution,
  PlacedWidget,
  PlotterExtensionManifest,
  ResourceFilterCondition,
  ResourceFilterSpec,
  WIDGET_CELL_GAP,
  WidgetCandidate,
  WidgetContribution,
  cellHeightPx,
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
  // placements whose extension is present and compatible (drives the overlay)
  readonly activeWidgets = signal<PlacedWidget[]>([]);
  readonly initialized = signal(false);

  /**
   * Bottom offset (px) for host chrome that normally lives in the
   * bottom-right corner (Freeboard's action button): 0 when no widgets
   * occupy the bottom-right anchor, otherwise just above the occupied rows.
   */
  readonly actionButtonLift = computed(() => {
    const br = this.activeWidgets().filter((p) => p.anchor === 'br');
    if (!br.length) return 0;
    const rows = br.some((p) => p.row === 0) ? 2 : 1;
    return rows * cellHeightPx() + (rows - 1) * WIDGET_CELL_GAP + 6;
  });

  /** Toolbar buttons contributed by compatible extensions. */
  readonly toolbarButtons = computed(() => {
    const result: Array<{
      extension: string;
      extensionName: string;
      button: ButtonContribution;
    }> = [];
    for (const [extension, manifest] of Object.entries(this.manifests())) {
      if (!this.isCompatible(manifest)) continue;
      for (const button of manifest.buttons ?? []) {
        if (
          button.apiVersion !== undefined &&
          button.apiVersion !== HOST_API_VERSION
        ) {
          continue;
        }
        result.push({ extension, extensionName: manifest.name, button });
      }
    }
    return result;
  });

  // ---------- extension panels (button-opened, ui.openPanel) ----------

  /**
   * Open panels live in a right-side drawer. keepAlive panels stay loaded
   * (hidden) when closed; onOpen panels are destroyed. One panel is visible
   * at a time.
   */
  readonly openPanels = signal<
    Array<{
      key: string;
      extension: string;
      panel: PanelContribution;
      visible: boolean;
    }>
  >([]);

  readonly visiblePanel = computed(
    () => this.openPanels().find((p) => p.visible) ?? null
  );

  openPanel(extension: string, panelId: string): boolean {
    const manifest = this.manifests()[extension];
    const panel = manifest?.panels?.find((p) => p.id === panelId);
    if (!panel || panel.type !== 'iframe' || !panel.url) return false;
    const key = `${extension}/${panelId}`;
    this.openPanels.update((panels) => {
      const existing = panels.find((p) => p.key === key);
      if (existing) {
        return panels.map((p) => ({ ...p, visible: p.key === key }));
      }
      return [
        ...panels.map((p) => ({ ...p, visible: false })),
        { key, extension, panel, visible: true }
      ];
    });
    return true;
  }

  /** Close the visible drawer panel (hide keepAlive, destroy others). */
  closeVisiblePanel() {
    this.openPanels.update((panels) => {
      const visible = panels.find((p) => p.visible);
      if (!visible) return panels;
      if (visible.panel.lifecycle === 'keepAlive') {
        return panels.map((p) => ({ ...p, visible: false }));
      }
      return panels.filter((p) => p.key !== visible.key);
    });
  }

  handleButtonAction(extension: string, button: ButtonContribution) {
    if (button.action?.type === 'openPanel' && button.action.panel) {
      this.openPanel(extension, button.action.panel);
    }
  }

  // ---------- resource display filters ----------

  /** type -> extension id -> filter */
  readonly resourceFilters = signal<
    Record<string, Record<string, ResourceFilterSpec>>
  >({});

  /** Notes to display: the resource cache with active filters applied. */
  readonly visibleNotes = computed<FBNotes>(() => {
    const notes = this.skres.notes();
    const filters = this.resourceFilters()['notes'];
    if (!filters || !Object.keys(filters).length) return notes;
    const specs = Object.values(filters);
    return notes.filter(([id, note]) =>
      specs.every((spec) => this.passesFilter(spec, id, note))
    );
  });

  /** Active-filter chips for the host UI. */
  readonly filterChips = computed(() => {
    const chips: Array<{
      type: string;
      extension: string;
      label: string;
    }> = [];
    for (const [type, byExt] of Object.entries(this.resourceFilters())) {
      for (const [extension, spec] of Object.entries(byExt)) {
        chips.push({
          type,
          extension,
          label:
            spec.label ??
            `${this.manifests()[extension]?.name ?? extension} filter`
        });
      }
    }
    return chips;
  });

  setResourceFilter(
    extension: string,
    type: string,
    filter: ResourceFilterSpec
  ) {
    this.resourceFilters.update((all) => ({
      ...all,
      [type]: { ...(all[type] ?? {}), [extension]: filter }
    }));
    this.publishToExtension(extension, 'filters.changed', { type });
  }

  clearResourceFilter(extension: string, type: string) {
    this.resourceFilters.update((all) => {
      const byExt = { ...(all[type] ?? {}) };
      delete byExt[extension];
      const next = { ...all };
      if (Object.keys(byExt).length) {
        next[type] = byExt;
      } else {
        delete next[type];
      }
      return next;
    });
    this.publishToExtension(extension, 'filters.changed', { type });
  }

  private passesFilter(
    spec: ResourceFilterSpec,
    id: string,
    resource: unknown
  ): boolean {
    let matches = true;
    if (spec.ids) {
      matches = spec.ids.includes(id);
    }
    if (matches && spec.match) {
      matches = spec.match.every((cond) =>
        this.evalCondition(cond, resource)
      );
    }
    return spec.mode === 'exclude' ? !matches : matches;
  }

  private evalCondition(
    cond: ResourceFilterCondition,
    resource: unknown
  ): boolean {
    let value: unknown = resource;
    for (const seg of cond.path.split('.')) {
      if (value === null || typeof value !== 'object') {
        value = undefined;
        break;
      }
      value = (value as Record<string, unknown>)[seg];
    }
    switch (cond.op) {
      case 'exists':
        return value !== undefined;
      case 'eq':
        return value === cond.value;
      case 'ne':
        return value !== cond.value;
      case 'lt':
        return typeof value === 'number' && value < (cond.value as number);
      case 'lte':
        return typeof value === 'number' && value <= (cond.value as number);
      case 'gt':
        return typeof value === 'number' && value > (cond.value as number);
      case 'gte':
        return typeof value === 'number' && value >= (cond.value as number);
      case 'in':
        return Array.isArray(cond.value) && cond.value.includes(value);
      case 'contains':
        if (typeof value === 'string') {
          return value
            .toLowerCase()
            .includes(String(cond.value).toLowerCase());
        }
        return Array.isArray(value) && value.includes(cond.value);
      default:
        return false;
    }
  }

  private contexts = new Set<LiveContext>();

  // ---- Signal K delta relay (one WS for all widget contexts) ----
  private ws: WebSocket | null = null;
  private wsReady = false;
  private pathRefs = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private app: AppFacade,
    private signalk: SignalKClient,
    private dialog: MatDialog,
    private skres: SKResourceService,
    private mapService: MapService
  ) {
    if (isDevMode()) {
      // console handle for exercising the host API during development
      (window as unknown as Record<string, unknown>)['fbPlotterExt'] = this;
    }
  }

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

  // ---------- discovery ----------

  private isCompatible(manifest: PlotterExtensionManifest): boolean {
    if (manifest.apiVersion !== HOST_API_VERSION) return false;
    return (manifest.requires ?? []).every((cap) =>
      HOST_CAPABILITIES.includes(cap)
    );
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

  placements(): PlacedWidget[] {
    return this.app.config.plotterExtensions.widgets;
  }

  /** 2x2 occupancy map of an anchor area: occupied[row][col]. */
  private occupancy(anchor: AnchorId): boolean[][] {
    const occupied = [
      [false, false],
      [false, false]
    ];
    for (const placed of this.placements()) {
      if (placed.anchor !== anchor) continue;
      const def = this.widgetDef(placed.extension, placed.widget);
      const size = parseSize(def?.size ?? '1x1');
      for (let r = placed.row; r < placed.row + size.rows && r < 2; r++) {
        for (let c = placed.col; c < placed.col + size.cols && c < 2; c++) {
          occupied[r][c] = true;
        }
      }
    }
    return occupied;
  }

  /** Whether a cell of an anchor area is occupied by a placed widget. */
  cellOccupied(anchor: AnchorId, cell: { col: number; row: number }): boolean {
    return this.occupancy(anchor)[cell.row]?.[cell.col] ?? true;
  }

  /**
   * A placement is valid when every needed cell is free and the widget does
   * not "float": widgets pack from the anchor's screen edge inward, so a
   * widget not touching the gravity row needs the cells between it and the
   * gravity edge occupied.
   */
  private isValidOrigin(
    anchor: AnchorId,
    size: { cols: number; rows: number },
    origin: { col: number; row: number },
    occupied: boolean[][]
  ): boolean {
    if (origin.col + size.cols > 2 || origin.row + size.rows > 2) return false;
    for (let r = origin.row; r < origin.row + size.rows; r++) {
      for (let c = origin.col; c < origin.col + size.cols; c++) {
        if (occupied[r][c]) return false;
      }
    }
    if (size.rows === 1) {
      const gravityRow = ANCHOR_GRAVITY[anchor] === 'bottom' ? 1 : 0;
      if (origin.row !== gravityRow) {
        // floating row: require support toward the gravity edge
        for (let c = origin.col; c < origin.col + size.cols; c++) {
          if (!occupied[gravityRow][c]) return false;
        }
      }
    }
    return true;
  }

  /** Candidate origins for an anchor, most-preferred (gravity/corner) first. */
  private originOrder(anchor: AnchorId): Array<{ col: number; row: number }> {
    const rows = ANCHOR_GRAVITY[anchor] === 'bottom' ? [1, 0] : [0, 1];
    const cols = ANCHOR_COL_ORDER[anchor];
    const order: Array<{ col: number; row: number }> = [];
    for (const row of rows) {
      for (const col of cols) {
        order.push({ col, row });
      }
    }
    return order;
  }

  /**
   * Best valid origin for a widget at an anchor. When a pressed cell is
   * given, only placements covering that cell are considered, so the user's
   * press location disambiguates (e.g. stacking on top of an existing
   * widget vs. filling the rest of the gravity row).
   */
  private findOrigin(
    anchor: AnchorId,
    widget: WidgetContribution,
    pressedCell?: { col: number; row: number }
  ): { col: number; row: number } | null {
    const size = parseSize(widget.size);
    const occupied = this.occupancy(anchor);
    for (const origin of this.originOrder(anchor)) {
      if (!this.isValidOrigin(anchor, size, origin, occupied)) continue;
      if (
        pressedCell &&
        !(
          pressedCell.col >= origin.col &&
          pressedCell.col < origin.col + size.cols &&
          pressedCell.row >= origin.row &&
          pressedCell.row < origin.row + size.rows
        )
      ) {
        continue;
      }
      return origin;
    }
    return null;
  }

  /**
   * All widgets (across compatible extensions) that could be added at the
   * pressed cell of an anchor area, each with its computed origin.
   */
  addableWidgets(
    anchor: AnchorId,
    pressedCell: { col: number; row: number }
  ): WidgetCandidate[] {
    const result: WidgetCandidate[] = [];
    for (const [extension, manifest] of Object.entries(this.manifests())) {
      if (!this.isCompatible(manifest)) continue;
      for (const widget of manifest.widgets ?? []) {
        if (widget.type !== 'iframe') continue;
        if (
          widget.apiVersion !== undefined &&
          widget.apiVersion !== HOST_API_VERSION
        ) {
          continue;
        }
        const origin = this.findOrigin(anchor, widget, pressedCell);
        if (origin) {
          result.push({
            extension,
            extensionName: manifest.name,
            widget,
            origin
          });
        }
      }
    }
    return result;
  }

  /** Place a widget at a previously computed origin (see addableWidgets). */
  placeWidget(
    extension: string,
    widget: WidgetContribution,
    anchor: AnchorId,
    origin: { col: number; row: number }
  ): PlacedWidget {
    const placed: PlacedWidget = {
      instanceId: crypto.randomUUID(),
      extension,
      widget: widget.id,
      anchor,
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

  private refreshActiveWidgets() {
    const manifests = this.manifests();
    this.activeWidgets.set(
      this.placements().filter((p) => {
        const manifest = manifests[p.extension];
        return (
          manifest &&
          this.isCompatible(manifest) &&
          manifest.widgets?.some((w) => w.id === p.widget)
        );
      })
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
        ...this.unitsMethods(),
        ...this.resourcesMethods(placed.extension),
        ...this.mapMethods(),
        'ui.openConfigPanel': async () => {
          this.openConfigPanel(placed);
          return {};
        },
        'ui.openPanel': async (params) => {
          const { panel } = (params ?? {}) as { panel?: string };
          if (!panel || !this.openPanel(placed.extension, panel)) {
            throw new RpcError(`No such panel: ${panel}`, {
              code: RPC_ERRORS.INVALID_PARAMS,
              reason: 'UNKNOWN_PANEL'
            });
          }
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
        ...this.unitsMethods(),
        ...this.resourcesMethods(opts.extension),
        ...this.mapMethods(),
        'ui.closePanel': async () => {
          opts.close();
          return {};
        },
        'ui.openPanel': async (params) => {
          const { panel } = (params ?? {}) as { panel?: string };
          if (!panel || !this.openPanel(opts.extension, panel)) {
            throw new RpcError(`No such panel: ${panel}`, {
              code: RPC_ERRORS.INVALID_PARAMS,
              reason: 'UNKNOWN_PANEL'
            });
          }
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

  // ---------- resources host API ----------

  private resourcesMethods(extension: string): Record<string, MethodHandler> {
    return {
      'resources.list': async (params) => {
        const { type, query } = (params ?? {}) as {
          type?: string;
          query?: Record<string, unknown>;
        };
        if (typeof type !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(type)) {
          throw new RpcError('resources.list requires a resource type', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'INVALID_TYPE'
          });
        }
        const qs = this.serializeQuery(query);
        try {
          const result = await firstValueFrom(
            this.signalk.api.get(
              this.app.skApiVersion,
              `/resources/${type}${qs}`
            )
          );
          return result ?? {};
        } catch (err) {
          throw new RpcError(`resources.list ${type} failed`, {
            reason: 'LIST_FAILED',
            data: { message: (err as Error)?.message }
          });
        }
      },
      'resources.setFilter': async (params) => {
        const { type, filter } = (params ?? {}) as {
          type?: string;
          filter?: ResourceFilterSpec;
        };
        if (
          typeof type !== 'string' ||
          !filter ||
          (filter.mode !== 'include' && filter.mode !== 'exclude') ||
          (filter.ids === undefined && filter.match === undefined) ||
          (filter.ids !== undefined &&
            (!Array.isArray(filter.ids) ||
              !filter.ids.every((id) => typeof id === 'string'))) ||
          (filter.match !== undefined && !Array.isArray(filter.match))
        ) {
          throw new RpcError(
            'resources.setFilter requires a type and a filter with mode plus ids and/or match',
            { code: RPC_ERRORS.INVALID_PARAMS, reason: 'INVALID_FILTER' }
          );
        }
        this.setResourceFilter(extension, type, filter);
        return {};
      },
      'resources.clearFilter': async (params) => {
        const { type } = (params ?? {}) as { type?: string };
        if (typeof type !== 'string') {
          throw new RpcError('resources.clearFilter requires a type', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'INVALID_TYPE'
          });
        }
        this.clearResourceFilter(extension, type);
        return {};
      }
    };
  }

  private serializeQuery(query?: Record<string, unknown>): string {
    if (!query || typeof query !== 'object') return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const serialized = Array.isArray(value)
        ? JSON.stringify(value)
        : String(value);
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(serialized)}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  // ---------- map host API ----------
  //
  // Map moves are routed through the host's own centering path
  // (AppFacade.mapMoveRequest -> AppComponent effect -> centerAndZoom), not
  // by reaching into the OpenLayers view directly. Driving the OL view
  // directly bypasses Freeboard's mapCenter/mapZoom signal flow, so chart
  // and resource layers do not refresh after the move.

  private mapMethods(): Record<string, MethodHandler> {
    return {
      'map.getView': async () => {
        return {
          center: this.app.config.map.center,
          zoom: this.app.config.map.zoomLevel,
          bounds: this.app.mapExtent()
        };
      },
      'map.center': async (params) => {
        const { position, zoom } = (params ?? {}) as {
          position?: [number, number];
          zoom?: number;
        };
        if (
          !Array.isArray(position) ||
          position.length !== 2 ||
          !position.every((v) => typeof v === 'number')
        ) {
          throw new RpcError('map.center requires position [lon, lat]', {
            code: RPC_ERRORS.INVALID_PARAMS,
            reason: 'INVALID_POSITION'
          });
        }
        this.app.mapMoveRequest.set({
          center: position as [number, number],
          ...(typeof zoom === 'number' ? { zoom } : {})
        });
        return {};
      },
      'map.fitBounds': async (params) => {
        const { bounds } = (params ?? {}) as { bounds?: number[] };
        if (
          !Array.isArray(bounds) ||
          bounds.length !== 4 ||
          !bounds.every((v) => typeof v === 'number')
        ) {
          throw new RpcError(
            'map.fitBounds requires bounds [minLon, minLat, maxLon, maxLat]',
            { code: RPC_ERRORS.INVALID_PARAMS, reason: 'INVALID_BOUNDS' }
          );
        }
        const [minLon, minLat, maxLon, maxLat] = bounds as number[];
        const center: [number, number] = [
          (minLon + maxLon) / 2,
          (minLat + maxLat) / 2
        ];
        this.app.mapMoveRequest.set({
          center,
          zoom: this.zoomForBounds(bounds as number[])
        });
        return {};
      }
    };
  }

  /**
   * Compute a zoom level that frames a lon/lat bounding box in the current
   * viewport (read-only use of the OL view). Falls back to a reasonable
   * zoom when the map is unavailable.
   */
  private zoomForBounds(bounds: number[]): number {
    const map = this.mapService.getMaps()[0];
    const size = map?.getSize();
    if (!map || !size) return 12;
    const view = map.getView();
    const ext = transformExtent(bounds, 'EPSG:4326', 'EPSG:3857');
    // pad by shrinking the usable size ~15% so markers aren't at the edge
    const padded: [number, number] = [size[0] * 0.85, size[1] * 0.85];
    const resolution = view.getResolutionForExtent(ext, padded);
    const zoom = view.getZoomForResolution(resolution) ?? 12;
    const maxZoom = this.app.MAP_ZOOM_EXTENT?.max ?? 18;
    return Math.min(zoom, maxZoom);
  }

  /**
   * Pulse OL map.updateSize() across a layout transition (the panel drawer
   * push), so the map tracks the changing container width smoothly.
   */
  pulseMapResize(durationMs = 320) {
    let elapsed = 0;
    const step = () => {
      this.mapService.updateSize();
      elapsed += 16;
      if (elapsed < durationMs) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- unit preferences ----------

  /**
   * Host API method exposing the user's preferred display units (Freeboard's
   * Settings -> Units tab) so extensions can pick sensible conversions.
   * Vocabulary follows Freeboard's settings values:
   *   speed: 'kn' | 'm/s' | 'km/h' | 'mph'
   *   distance: 'kilometer' | 'naut-mile'
   *   depth / length: 'm' | 'foot'
   *   temperature: 'C' | 'F'
   */
  private unitsMethods(): Record<string, MethodHandler> {
    return {
      'units.get': async () => {
        const u = this.app.config.units;
        return {
          units: {
            speed: u.speed,
            distance: u.distance,
            depth: u.depth,
            length: u.length,
            temperature: u.temperature
          }
        };
      }
    };
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
