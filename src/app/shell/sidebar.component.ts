import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AdminAuthService } from '../core/auth/admin-auth.service';
import { ElevationService } from '../core/auth/elevation.service';
import { SessionStore } from '../core/auth/session.store';
import { NAV_DESTINATIONS } from './navigation';

/**
 * The dark chrome. Five destinations, then the operator and Sign out.
 *
 * Dark chrome around a light working area is half of what makes this application
 * unmistakable beside the restaurant portal — and spec §16 treats that distinctness
 * as a SAFETY requirement, because during a delegated support session both are open
 * at once and acting in the wrong one is a real operational error.
 *
 * ── RE-AUTHENTICATE IS NOT A SIXTH DESTINATION ────────────────────────────────────
 *
 * It is an ACTION on the current session, so it belongs in the operator block beside
 * Sign out rather than in the navigation list — §9 is still exactly five destinations.
 * It opens the EXISTING elevation dialog through the EXISTING queue; there is no
 * second prompt anywhere in this repo.
 *
 * ── AND IT IS THE WRITE-PATH SMOKE TEST ───────────────────────────────────────────
 *
 * `POST /auth/elevate/` is the only unsafe request this scaffold can make, so this
 * button is the only thing that exercises the CSRF cookie read, the `X-CSRFToken`
 * header and the server's double-submit check in a browser. After 0C ships the deploy
 * it is what proves that path works against real Apache — before step 4 puts a
 * lifecycle transition behind it. It is a real affordance either way: an operator
 * about to do something consequential would rather clear the window deliberately than
 * be interrupted mid-action.
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
          [class]="menuItem"
          [disabled]="reauthenticating()"
          (click)="reauthenticate()"
        >
          <svg class="h-4 w-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
            <path
              fill="currentColor"
              d="M8 2a6 6 0 0 0-5.66 4h1.5A4.5 4.5 0 0 1 8 3.5c1.5 0 2.82.74 3.63 1.87H9.6v1.4h4.3V2.5h-1.4v1.6A5.98 5.98 0 0 0 8 2Zm-5.9 3.9v4.6h1.4V8.9A5.98 5.98 0 0 0 8 14a6 6 0 0 0 5.66-4h-1.5A4.5 4.5 0 0 1 8 12.5a4.5 4.5 0 0 1-3.63-1.87H6.4v-1.4Z"
            />
          </svg>
          Re-authenticate
        </button>
        <button type="button" [class]="menuItem" (click)="signOut()">
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
  private readonly elevation = inject(ElevationService);

  protected readonly reauthenticating = signal(false);

  protected readonly menuItem =
    'flex h-control w-full items-center gap-2.5 rounded px-2.5 text-admin-label ' +
    'text-chrome-fg-muted transition-colors hover:bg-chrome-raised hover:text-chrome-fg ' +
    'disabled:cursor-not-allowed disabled:opacity-55';

  protected signOut(): void {
    void this.auth.signOut();
  }

  /**
   * Join the elevation queue deliberately rather than by being refused.
   *
   * THE ERROR CALLBACK IS NOT OPTIONAL. Dismissing the dialog fails every queued
   * attempt with `ElevationCancelledError`, and an unhandled error on this
   * subscription would surface as an unhandled rejection in the console for what is a
   * completely ordinary operator choice. Both nameable failures — cancelled, and
   * abandoned because the service did not answer — land here and simply release the
   * button.
   */
  protected reauthenticate(): void {
    if (this.reauthenticating()) return;
    this.reauthenticating.set(true);

    this.elevation.request('deliberate').subscribe({
      error: () => this.reauthenticating.set(false),
      complete: () => this.reauthenticating.set(false),
    });
  }
}
