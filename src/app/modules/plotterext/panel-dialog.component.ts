// Material dialog hosting an extension panel iframe (used for widget
// configuration panels in this phase; generic panels reuse it later).

import {
  Component,
  ElementRef,
  Inject,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { PlotterExtensionService } from './plotterext.service';
import { PanelContribution } from './types';

export interface PlotterPanelDialogData {
  extension: string;
  panel: PanelContribution;
  targetInstance?: string | null;
  targetWidget?: string | null;
}

@Component({
  selector: 'fb-plotterext-panel-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <div class="pe-panel-header" mat-dialog-title>
      <span>{{ data.panel.title }}</span>
      <button mat-icon-button (click)="dialogRef.close()" aria-label="Close">
        <mat-icon>close</mat-icon>
      </button>
    </div>
    <mat-dialog-content class="pe-panel-content">
      <iframe
        #frame
        [src]="url"
        sandbox="allow-scripts allow-same-origin allow-forms"
        [title]="data.panel.title"
      ></iframe>
    </mat-dialog-content>
    @if (data.targetInstance) {
      <mat-dialog-actions class="pe-panel-actions">
        <button mat-button class="pe-remove" (click)="removeWidget()">
          <mat-icon>delete</mat-icon> Remove widget
        </button>
      </mat-dialog-actions>
    }
  `,
  styles: [
    `
      .pe-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-right: 8px;
      }
      .pe-panel-content {
        padding: 0;
        height: 60vh;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: none;
      }
      .pe-panel-actions {
        justify-content: flex-start;
      }
      .pe-remove {
        color: #d32f2f;
      }
    `
  ]
})
export class PlotterPanelDialog implements OnInit, OnDestroy {
  @ViewChild('frame', { static: true })
  frame: ElementRef<HTMLIFrameElement>;

  url: SafeResourceUrl;
  private detach: (() => void) | null = null;

  constructor(
    public dialogRef: MatDialogRef<PlotterPanelDialog>,
    @Inject(MAT_DIALOG_DATA) public data: PlotterPanelDialogData,
    private service: PlotterExtensionService,
    private sanitizer: DomSanitizer
  ) {}

  ngOnInit() {
    this.url = this.sanitizer.bypassSecurityTrustResourceUrl(
      this.data.panel.url
        ? this.service.resolveAssetUrl(this.data.panel.url)
        : 'about:blank'
    );
    this.detach = this.service.attachPanel(this.frame.nativeElement, {
      extension: this.data.extension,
      panel: this.data.panel,
      targetInstance: this.data.targetInstance,
      targetWidget: this.data.targetWidget,
      close: () => this.dialogRef.close()
    });
  }

  removeWidget() {
    if (this.data.targetInstance) {
      this.service.removeWidget(this.data.targetInstance);
    }
    this.dialogRef.close();
  }

  ngOnDestroy() {
    this.detach?.();
    this.detach = null;
  }
}
