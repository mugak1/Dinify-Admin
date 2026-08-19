import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AdminAuthService } from '../core/auth/admin-auth.service';
import { SessionStore } from '../core/auth/session.store';
import { NAV_DESTINATIONS } from './navigation';

/**
 * The dark chrome. Five destinations, then the operator and Sign out.
 *
 * Dark chrome around a light working area is half of what makes this application
 * unmistakable beside the restaurant portal — and spec §16 treats that distinctness
 * as a SAFETY requirement, because during a delegated support session both are open
 * at once and acting in the wrong one is a real operational error.
 */
@Component({
  selector: 'app-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav
      class="flex h-full w-sidebar shrink-0 flex-col bg-chrome text-chrome-fg"
      aria-label="Primary"
    >
      <div class="flex h-topbar items-center gap-2 border-b border-chrome-border px-4">
        <span
          class="flex h-5 w-5 items-center justify-center rounded-sm bg-admin-accent
                 text-admin-micro text-admin-accent-fg"
          aria-hidden="true"
          >D</span
        >
        <span class="text-admin-label text-chrome-fg">Dinify Admin</span>
      </div>

      <ul class="flex-1 space-y-0.5 p-2">
        @for (item of destinations; track item.path) {
          <li>
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-chrome-raised text-chrome-fg"
              [routerLinkActiveOptions]="{ exact: item.path === '/' }"
              [attr.title]="item.description"
              class="flex h-control items-center gap-2.5 rounded px-2.5 text-admin-label
                     text-chrome-fg-muted transition-colors hover:bg-chrome-raised
                     hover:text-chrome-fg"
            >
              <svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
                <path fill="currentColor" [attr.d]="item.icon" />
              </svg>
              {{ item.label }}
            </a>
          </li>
        }
      </ul>

      <div class="border-t border-chrome-border p-2">
        <div class="px-2.5 py-1.5">
          <p class="truncate text-admin-label text-chrome-fg">{{ session.username() ?? '—' }}</p>
          <p class="truncate text-admin-meta text-chrome-fg-muted">Platform staff</p>
        </div>
        <button
          type="button"
          class="flex h-control w-full items-center gap-2.5 rounded px-2.5 text-admin-label
                 text-chrome-fg-muted transition-colors hover:bg-chrome-raised hover:text-chrome-fg"
          (click)="signOut()"
        >
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M6.4 2h-3A1.4 1.4 0 0 0 2 3.4v9.2A1.4 1.4 0 0 0 3.4 14h3v-1.4h-3V3.4h3Zm4.1 2.1-1 1 1.6 1.6H6v1.4h5.1L9.5 9.7l1 1L13.9 8Z"
            />
          </svg>
          Sign out
        </button>
      </div>
    </nav>
  `,
})
export class SidebarComponent {
  protected readonly destinations = NAV_DESTINATIONS;
  protected readonly session = inject(SessionStore);
  private readonly auth = inject(AdminAuthService);

  protected signOut(): void {
    void this.auth.signOut();
  }
}
