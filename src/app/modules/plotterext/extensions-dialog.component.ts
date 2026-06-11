// Extensions management dialog: enable/disable discovered extensions and
// place/remove their widgets. Placement is user-driven per the spec: the
// widget only declares its size; the user picks the corner (cells are
// auto-assigned first-fit within the corner in this build).

import { Component, Inject, signal } from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { PlotterExtensionService } from './plotterext.service';
import {
  CORNER_LABELS,
  CORNERS,
  Corner,
  ExtensionInfo,
  WidgetContribution
} from './types';

@Component({
  selector: 'fb-plotterext-dialog',
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    FormsModule
  ],
  template: `
    <div mat-dialog-title class="pe-title">
      <mat-icon>extension</mat-icon>
      <span>Plotter Extensions</span>
    </div>
    <mat-dialog-content>
      @if (extensions().length === 0) {
        <p class="pe-empty">
          No extensions found. Install a Signal K plugin that provides
          <code>plotterExtensions</code> resources, then reload.
        </p>
      }
      @for (ext of extensions(); track ext.id) {
        <div class="pe-ext">
          <div class="pe-ext-head">
            <div>
              <div class="pe-ext-name">{{ ext.manifest.name }}</div>
              <div class="pe-ext-desc">
                {{ ext.manifest.description }}
                @if (ext.manifest.version) {
                  <span class="pe-ver">v{{ ext.manifest.version }}</span>
                }
              </div>
            </div>
            <mat-slide-toggle
              [checked]="ext.enabled"
              [disabled]="!ext.compatible"
              (change)="setEnabled(ext, $event.checked)"
              [matTooltip]="
                ext.compatible
                  ? ''
                  : 'Not compatible with this host: ' + ext.incompatibleReason
              "
            ></mat-slide-toggle>
          </div>

          @if (ext.enabled) {
            @for (widget of widgetsOf(ext); track widget.id) {
              <div class="pe-widget-row">
                <span class="pe-widget-name"
                  >{{ widget.title }}
                  <span class="pe-size">{{ widget.size }}</span></span
                >
                <mat-select
                  class="pe-corner-select"
                  [(ngModel)]="cornerChoice[ext.id + '/' + widget.id]"
                  placeholder="Corner"
                >
                  @for (corner of corners; track corner) {
                    <mat-option [value]="corner">{{
                      cornerLabels[corner]
                    }}</mat-option>
                  }
                </mat-select>
                <button
                  mat-stroked-button
                  (click)="place(ext, widget)"
                  [disabled]="!cornerChoice[ext.id + '/' + widget.id]"
                >
                  <mat-icon>add</mat-icon> Place
                </button>
              </div>
            }
            @for (placed of placementsOf(ext); track placed.instanceId) {
              <div class="pe-placed-row">
                <mat-icon class="pe-placed-icon">widgets</mat-icon>
                <span
                  >{{ widgetTitle(ext, placed.widget) }} —
                  {{ cornerLabels[placed.corner] }}</span
                >
                <span class="pe-flex"></span>
                <button
                  mat-icon-button
                  (click)="configure(placed.instanceId)"
                  matTooltip="Configure"
                >
                  <mat-icon>settings</mat-icon>
                </button>
                <button
                  mat-icon-button
                  (click)="remove(placed.instanceId)"
                  matTooltip="Remove widget"
                >
                  <mat-icon>delete</mat-icon>
                </button>
              </div>
            }
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="dialogRef.close()">Close</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .pe-title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pe-empty {
        max-width: 360px;
      }
      .pe-ext {
        border: 1px solid rgba(128, 128, 128, 0.35);
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 10px;
        min-width: 380px;
      }
      .pe-ext-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .pe-ext-name {
        font-weight: 600;
      }
      .pe-ext-desc {
        font-size: 12px;
        opacity: 0.75;
        max-width: 320px;
      }
      .pe-ver {
        margin-left: 6px;
        opacity: 0.6;
      }
      .pe-widget-row,
      .pe-placed-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .pe-widget-name {
        flex: 1;
      }
      .pe-size {
        font-size: 11px;
        opacity: 0.6;
        margin-left: 4px;
      }
      .pe-corner-select {
        width: 130px;
      }
      .pe-placed-row {
        font-size: 13px;
        opacity: 0.9;
      }
      .pe-placed-icon {
        font-size: 18px;
        height: 18px;
        width: 18px;
      }
      .pe-flex {
        flex: 1;
      }
    `
  ]
})
export class PlotterExtensionsDialog {
  corners = CORNERS;
  cornerLabels = CORNER_LABELS;
  cornerChoice: Record<string, Corner> = {};
  refresh = signal(0);

  constructor(
    public dialogRef: MatDialogRef<PlotterExtensionsDialog>,
    @Inject(MAT_DIALOG_DATA) public data: unknown,
    private service: PlotterExtensionService
  ) {}

  extensions(): ExtensionInfo[] {
    this.refresh();
    return this.service.extensions();
  }

  widgetsOf(ext: ExtensionInfo): WidgetContribution[] {
    return this.service.placeableWidgets(ext.id);
  }

  placementsOf(ext: ExtensionInfo) {
    this.refresh();
    return this.service.placements().filter((p) => p.extension === ext.id);
  }

  widgetTitle(ext: ExtensionInfo, widgetId: string): string {
    return (
      ext.manifest.widgets?.find((w) => w.id === widgetId)?.title ?? widgetId
    );
  }

  setEnabled(ext: ExtensionInfo, enabled: boolean) {
    this.service.setEnabled(ext.id, enabled);
    this.refresh.update((n) => n + 1);
  }

  place(ext: ExtensionInfo, widget: WidgetContribution) {
    const corner = this.cornerChoice[`${ext.id}/${widget.id}`];
    if (!corner) return;
    const placed = this.service.placeWidget(ext.id, widget, corner);
    if (!placed) {
      alert(
        `No room for a ${widget.size} widget in the ${CORNER_LABELS[corner]} corner.`
      );
    }
    this.refresh.update((n) => n + 1);
  }

  remove(instanceId: string) {
    this.service.removeWidget(instanceId);
    this.refresh.update((n) => n + 1);
  }

  configure(instanceId: string) {
    const placed = this.service
      .placements()
      .find((p) => p.instanceId === instanceId);
    if (placed) this.service.openConfigPanel(placed);
  }
}
