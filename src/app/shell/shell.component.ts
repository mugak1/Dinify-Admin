import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { DefectBannerComponent } from '../ui/defect-banner.component';
import { ElevationDialogComponent } from '../ui/elevation-dialog.component';
import { NoticeBannerComponent } from '../ui/notice-banner.component';
import { ServiceUnavailableBannerComponent } from '../ui/service-unavailable-banner.component';
import { SidebarComponent } from './sidebar.component';

/**
 * The authenticated frame: dark chrome on the left, light working area on the right.
 *
 * Four things are mounted here rather than per-screen, because all four are global by
 * nature and mounting them anywhere else would mean remembering to:
 *
 *   - the re-elevation dialog, which any request in the application can summon;
 *   - the defect banner, which surfaces the request ID for failures no screen owns;
 *   - the outage banner, for a MID-SESSION unavailability. The session was never
 *     denied, so the frame stays up and the operator keeps their place — the
 *     cold-start case is a whole view (`ServiceUnavailablePage`) because there is
 *     nothing else to show there;
 *   - the notice banner, the single channel for post-authentication facts (low
 *     recovery codes, a cleared lockout) that used to reach only `console.warn`.
 *
 * THREE CHANNELS, EACH HOLDING AT MOST ONE MESSAGE — a live outage state, one defect,
 * one composed notice. Not a stack, and deliberately not a toast surface: see
 * `NoticeService` for the boundary and why it is drawn there.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    SidebarComponent,
    DefectBannerComponent,
    ElevationDialogComponent,
    NoticeBannerComponent,
    ServiceUnavailableBannerComponent,
  ],
  template: `
    <div class="flex h-screen overflow-hidden bg-canvas">
      <app-sidebar />

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex-1 overflow-y-auto">
          <div class="mx-auto max-w-6xl space-y-4 p-6">
            <!-- Ordered by how much they change what the operator should do next:
                 the control plane being down outranks a past failure, which outranks
                 a standing warning. -->
            <app-service-unavailable-banner />
            <app-defect-banner />
            <app-notice-banner />
            <router-outlet />
          </div>
        </div>
      </div>
    </div>

    <app-elevation-dialog />
  `,
})
export class ShellComponent {}
