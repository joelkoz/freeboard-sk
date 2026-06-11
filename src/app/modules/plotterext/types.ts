// Types for the plotter extension host (plotterExtensions resource type).
// Mirrors the plotter extension provider specification. Declared locally so
// the branch does not depend on a server-api release.

export const PLOTTER_EXTENSIONS_RESOURCE = 'plotterExtensions';

/** Host API major version implemented by this Freeboard build. */
export const HOST_API_VERSION = '1';

/** Capabilities advertised by this (partial, widget-focused) host build. */
export const HOST_CAPABILITIES = [
  'widgets',
  'panels.iframe',
  'signalk.stream',
  'signalk.put'
];

export type WidgetSize = '1x1' | '2x1' | '1x2' | '2x2';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

export const CORNERS: Corner[] = ['tl', 'tr', 'bl', 'br'];

export const CORNER_LABELS: Record<Corner, string> = {
  tl: 'Top left',
  tr: 'Top right',
  bl: 'Bottom left',
  br: 'Bottom right'
};

export interface WidgetContribution {
  id: string;
  title: string;
  type: 'iframe';
  url: string;
  size: WidgetSize;
  configPanel?: string;
  lifecycle?: string;
  apiVersion?: string;
}

export interface PanelContribution {
  id: string;
  title: string;
  type: 'iframe' | 'customElement';
  url?: string;
  moduleUrl?: string;
  tagName?: string;
  lifecycle?: string;
  apiVersion?: string;
}

export interface PlotterExtensionManifest {
  name: string;
  description?: string;
  version?: string;
  apiVersion: string;
  requires?: string[];
  optional?: string[];
  widgets?: WidgetContribution[];
  panels?: PanelContribution[];
  // Future contribution sections (buttons, background, resourceFilters) are
  // tolerated but not consumed by this build.
  [key: string]: unknown;
}

/** A widget placement persisted in app config (see IAppConfig). */
export interface PlacedWidget {
  instanceId: string;
  extension: string;
  widget: string;
  corner: Corner;
  col: number;
  row: number;
}

export interface ExtensionInfo {
  id: string;
  manifest: PlotterExtensionManifest;
  compatible: boolean;
  incompatibleReason?: string;
  enabled: boolean;
}

export function parseSize(size: WidgetSize | string): {
  cols: number;
  rows: number;
} {
  const m = /^([12])x([12])$/.exec(size ?? '');
  if (!m) return { cols: 1, rows: 1 };
  return { cols: Number(m[1]), rows: Number(m[2]) };
}
