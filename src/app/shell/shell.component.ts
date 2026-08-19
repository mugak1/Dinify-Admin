import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { DefectBannerComponent } from '../ui/defect-banner.component';
import { ElevationDialogComponent } from '../ui/elevation-dialog.component';
import { SidebarComponent } from './sidebar.component';

/**
 * The authenticated frame: dark chrome on the left, light working area on the right.
 *
 * Two things are mounted here rather than per-screen, because both are global by
 * nature and mounting them anywhere else would mean remembering to:
 *
 *   - the re-elevation dialog, which any request in the application can summon;
 *   - the defect banner, which surfaces the request ID for failures no screen owns.
 */
@Component({
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, SidebarComponent, DefectBannerComponent, ElevationDialogComponent],
  template: `
    <div class="flex h-screen overflow-hidden bg-canvas">
      <app-sidebar />

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex-1 overflow-y-auto">
          <div class="mx-auto max-w-6xl space-y-4 p-6">
            <app-defect-banner />
            <router-outlet />
          </div>
        </div>
      </div>
    </div>

    <app-elevation-dialog />
  `,
})
export class ShellComponent {}
