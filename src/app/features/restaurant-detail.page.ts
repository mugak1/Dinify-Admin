import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { StatusPillComponent } from '../ui/status-pill.component';

/**
 * The restaurant detail workspace — spec §9.1 calls it the most important screen in
 * the portal. THE STRUCTURE ONLY; step 1 populates it.
 *
 * The shape is deliberate: a PERSISTENT HEADER carrying state, then tabs. Because the
 * header persists, the operator always knows which tenant they are acting on — which
 * matters most in exactly the situation where it is easiest to lose track, a
 * delegated support session with the restaurant portal open in another window.
 *
 * §9.1 also puts the PRIMARY ACTION here and makes it LIFECYCLE-DEPENDENT, so the
 * interface says what should happen next rather than merely displaying state:
 * `onboarding` → Review readiness (or Go live once ready); `live` → Open workspace;
 * `suspended` → Review suspension. Consequential, infrequent actions (go live,
 * suspend, offboard) belong in an overflow menu, with emergency freeze visually and
 * interactionally SEPARATED from ordinary suspension. None of that is built here.
 *
 * `id` is bound from the route by `withComponentInputBinding()`.
 */
@Component({
  selector: 'app-restaurant-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, StatusPillComponent],
  template: `
    <header class="space-y-3">
      <a routerLink="/restaurants" class="text-admin-meta text-ink-muted hover:text-ink"
        >&larr; Restaurants</a
      >

      <div>
        <h1 class="text-admin-page text-ink">Restaurant</h1>
        <p class="mt-0.5 text-admin-meta text-ink-subtle tabular-figures">{{ id() }}</p>
      </div>

      <div class="flex items-center gap-2">
        <app-status-pill variant="neutral" label="No data" />
      </div>

      <nav class="flex gap-1 border-b border-line" aria-label="Restaurant sections">
        @for (tab of tabs; track tab.path) {
          <a
            [routerLink]="tab.path === '' ? ['.'] : ['.', tab.path]"
            routerLinkActive="border-admin-accent text-ink"
            [routerLinkActiveOptions]="{ exact: tab.path === '' }"
            class="-mb-px border-b-2 border-transparent px-3 py-2 text-admin-label
                   text-ink-muted hover:text-ink"
          >
            {{ tab.label }}
          </a>
        }
      </nav>
    </header>

    <router-outlet />
  `,
})
export class RestaurantDetailPage {
  /** Bound from `/restaurants/:id` by withComponentInputBinding(). */
  readonly id = input.required<string>();

  protected readonly tabs = [
    { path: '', label: 'Overview' },
    { path: 'readiness', label: 'Readiness' },
    { path: 'billing', label: 'Billing' },
    { path: 'support', label: 'Support' },
    { path: 'activity', label: 'Activity' },
  ];
}
