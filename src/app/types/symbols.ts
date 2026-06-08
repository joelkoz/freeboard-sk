export const SYMBOL_RESOURCE_TYPE = 'symbols' as const;

export type SymbolRole =
  | 'note'
  | 'waypoint'
  | 'region'
  | 'button'
  | 'alert'
  | 'logbook'
  | 'map-marker'
  | 'vector-style-icon'
  | string;

export interface SymbolDefinition {
  id: string;
  namespace: string;
  name: string;
  description?: string;
  mediaType: 'image/svg+xml';
  url: string;
  roles?: SymbolRole[];
  tags?: string[];
  scale?: number;
  anchor?: [number, number];
}

export interface SymbolResource extends SymbolDefinition {
  $source?: string;
  timestamp?: string;
}

export type SymbolReference = string; // "namespace:id"
