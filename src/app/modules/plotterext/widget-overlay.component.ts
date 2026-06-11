// Widget overlay: a full-map-size layer with a 2x2 widget grid anchored in
// each corner. The overlay itself never intercepts pointer events; only the
// widget frames do.

import { Component, computed } from '@angular/core';
import { PlotterExtensionService } from './plotterext.service';
import { PlotterWidgetFrame } from './widget-frame.component';
import { CORNERS, PlacedWidget, parseSize } from './types';

interface CellStyle {
  [key: string]: string;
}

@Component({
  selector: 'fb-plotterext-overlay',
  imports: [PlotterWidgetFrame],
  template: `
    @for (corner of corners; track corner) {
      <div class="pe-corner" [class]="'pe-' + corner">
        @for (placed of byCorner()[corner]; track placed.instanceId) {
          <div class="pe-cell" [style]="cellStyle(placed)">
            <fb-plotterext-widget [placed]="placed"></fb-plotterext-widget>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        z-index: 2000;
        pointer-events: none;
        --pe-cell-w: clamp(96px, 11vw, 150px);
        --pe-cell-h: clamp(84px, 9.5vw, 124px);
        --pe-gap: 6px;
        --pe-margin: 10px;
      }
      .pe-corner {
        position: absolute;
        display: grid;
        grid-template-columns: repeat(2, var(--pe-cell-w));
        grid-template-rows: repeat(2, var(--pe-cell-h));
        gap: var(--pe-gap);
        pointer-events: none;
      }
      /* offsets keep widget areas clear of Freeboard's own chrome:
         top/left button columns, right button bar, bottom status bar */
      .pe-tl {
        top: 60px;
        left: 56px;
      }
      .pe-tr {
        top: 60px;
        right: 56px;
      }
      .pe-bl {
        bottom: calc(var(--pe-margin) + 32px);
        left: 56px;
      }
      .pe-br {
        bottom: calc(var(--pe-margin) + 32px);
        right: 56px;
      }
      .pe-cell {
        pointer-events: auto;
        overflow: hidden;
        border-radius: 10px;
        box-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);
      }
    `
  ]
})
export class PlotterExtensionOverlay {
  corners = CORNERS;

  byCorner = computed(() => {
    const result: Record<string, PlacedWidget[]> = {
      tl: [],
      tr: [],
      bl: [],
      br: []
    };
    for (const placed of this.service.activeWidgets()) {
      result[placed.corner]?.push(placed);
    }
    return result;
  });

  constructor(private service: PlotterExtensionService) {}

  cellStyle(placed: PlacedWidget): CellStyle {
    const def = this.service.widgetDef(placed.extension, placed.widget);
    const { cols, rows } = parseSize(def?.size ?? '1x1');
    return {
      'grid-column': `${placed.col + 1} / span ${cols}`,
      'grid-row': `${placed.row + 1} / span ${rows}`
    };
  }
}
