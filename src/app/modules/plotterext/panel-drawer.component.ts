// Right-side drawer hosting extension panels opened via toolbar buttons or
// ui.openPanel. keepAlive panels stay loaded when hidden (their iframe
// element is preserved — reparenting an iframe would reload it); onOpen
// panels are removed from the registry and destroyed on close.

import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  inject,
  input
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { PlotterExtensionService } from './plotterext.service';
import { PanelContribution } from './types';

@Component({
  selector: 'fb-plotterext-panel-frame',
  imports: [],
  template: `
    <iframe
      #frame
      [src]="url"
      sandbox="allow-scripts allow-same-origin allow-forms"
      [title]="panel().title"
    ></iframe>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: none;
      }
    `
  ]
})
export class PlotterPanelFrame implements OnInit, OnDestroy {
  extension = input.required<string>();
  panel = input.required<PanelContribution>();

  @ViewChild('frame', { static: true })
  frame: ElementRef<HTMLIFrameElement>;

  url: SafeResourceUrl;
  private detach: (() => void) | null = null;
  private service = inject(PlotterExtensionService);
  private sanitizer = inject(DomSanitizer);

  ngOnInit() {
    this.url = this.sanitizer.bypassSecurityTrustResourceUrl(
      this.panel().url ? this.service.resolveAssetUrl(this.panel().url) : 'about:blank'
    );
    this.detach = this.service.attachPanel(this.frame.nativeElement, {
      extension: this.extension(),
      panel: this.panel(),
      close: () => this.service.closeVisiblePanel()
    });
  }

  ngOnDestroy() {
    this.detach?.();
    this.detach = null;
  }
}

@Component({
  selector: 'fb-plotterext-panel-drawer',
  imports: [MatButtonModule, MatIconModule, PlotterPanelFrame],
  template: `
    @for (entry of service.openPanels(); track entry.key) {
      <div class="pe-drawer" [class.pe-drawer-hidden]="!entry.visible">
        <div class="pe-drawer-head">
          <span>{{ entry.panel.title }}</span>
          <button
            mat-icon-button
            (click)="service.closeVisiblePanel()"
            aria-label="Close panel"
          >
            <mat-icon>close</mat-icon>
          </button>
        </div>
        <div class="pe-drawer-body">
          <fb-plotterext-panel-frame
            [extension]="entry.extension"
            [panel]="entry.panel"
          ></fb-plotterext-panel-frame>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .pe-drawer {
        position: fixed;
        top: 48px;
        right: 0;
        bottom: 0;
        width: min(390px, 92vw);
        z-index: 2500;
        display: flex;
        flex-direction: column;
        background: #1d242b;
        color: #e8edf2;
        box-shadow: -2px 0 8px rgba(0, 0, 0, 0.4);
      }
      .pe-drawer-hidden {
        visibility: hidden;
        pointer-events: none;
      }
      .pe-drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 4px 4px 14px;
        font-weight: 600;
        border-bottom: 1px solid rgba(255, 255, 255, 0.12);
        flex: 0 0 auto;
      }
      .pe-drawer-body {
        flex: 1;
        min-height: 0;
      }
    `
  ]
})
export class PlotterPanelDrawer {
  protected service = inject(PlotterExtensionService);
}
