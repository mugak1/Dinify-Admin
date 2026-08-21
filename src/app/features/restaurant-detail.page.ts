import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import {
  lifecycleLabel,
  lifecycleMeaning,
  lifecycleVariant,
} from '../core/restaurants/restaurant.labels';
import { RestaurantWorkspaceStore } from '../core/restaurants/restaurant-workspace.store';
import { adminButtonClasses, AdminButtonComponent } from '../ui/button.component';
import { StatusPillComponent } from '../ui/status-pill.component';

/**
 * The restaurant detail workspace — spec §9.1 calls it the most important screen in
 * the portal. A PERSISTENT HEADER carrying state, then tabs.
 *
 * Because the header persists across the tabs, the operator always knows which tenant
 * they are acting on — which matters most in exactly the situation where it is easiest
 * to lose track: a delegated support session with the restaurant portal open in
 * another window.
 *
 * ── THIS COMPONENT OWNS THE DETAIL READ ───────────────────────────────────────────
 *
 * It calls `RestaurantWorkspaceStore.load()`; the tabs INJECT the same store and read
 * its signals. So `GET /restaurants/<id>/` happens ONCE for the workspace rather than
 * once per tab, and the header and Overview can never disagree with each other about
 * the same restaurant. The store is provided on the ROUTE (see `app.routes.ts`), so
 * its lifetime is the workspace's.
 *
 * ── THE PRIMARY ACTION IS ONLY WHAT EXISTS TODAY ──────────────────────────────────
 *
 * §9.1 makes it lifecycle-dependent — `onboarding` → Review readiness, `live` → Open
 * workspace, `suspended` → Review suspension. Only the FIRST is real in this slice,
 * because it is navigation to a tab that exists. The others need capability that does
 * not: delegated drill-in is step 5 and its cross-origin handoff is unbuilt, and there
 * is no suspension review to open. A button that looks like the product and does
 * nothing teaches an operator to distrust every button beside it, so the others are
 * absent rather than disabled — while the slot they will occupy is kept, so step 4 and
 * step 5 land in a layout that already fits them.
 *
 * `id` is bound from the route by `withComponentInputBinding()`.
 */
@Component({
  selector: 'app-restaurant-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminButtonComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    StatusPillComponent,
  ],
  template: `
    <header class="space-y-3">
      <a routerLink="/restaurants" class="text-admin-meta text-ink-muted hover:text-ink"
        >&larr; Restaurants</a
      >

      @switch (workspace.state()) {
        @case ('loaded') {
          @if (workspace.detail(); as restaurant) {
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <h1 class="text-admin-page text-ink">{{ restaurant.name }}</h1>
                  @if (restaurant.is_test) {
                    <!-- §16: a test tenant must be unmistakable, on the detail header
                         as well as the directory row. The solid pill, not a variant. -->
                    <app-status-pill variant="test" />
                  }
                </div>
                <p class="mt-0.5 text-admin-meta text-ink-subtle">
                  @if (restaurant.location) {
                    <span>{{ restaurant.location }}</span>
                    <span aria-hidden="true"> · </span>
                  }
                  <!-- The UUID is the only identity the backend has: there is no
                       human-readable reference, and minting one in the portal would
                       invent a business key nothing else writes. Kept subdued. -->
                  <span class="tabular-figures">{{ restaurant.id }}</span>
                </p>
              </div>

              <!-- The primary-action slot. Empty for every state whose action is not
                   yet real — see the class comment. -->
              <div class="flex items-center gap-2">
                @if (restaurant.status === 'onboarding') {
                  <!-- NAVIGATION, so an anchor: §19 keeps <button> for actions and
                       <a> for going somewhere. Read-only and safe in this slice. -->
                  <a [routerLink]="['.', 'readiness']" [class]="primaryActionClasses"
                    >Review readiness</a
                  >
                }
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <app-status-pill [variant]="lifecycleVariant(restaurant.status)" />
              <span class="text-admin-meta text-ink-muted">{{
                lifecycleMeaning(restaurant.status)
              }}</span>
            </div>
          }
        }

        @case ('loading') {
          <div class="space-y-2" aria-busy="true">
            <p class="text-admin-body text-ink-muted">Loading restaurant…</p>
            <div class="h-row w-64 animate-pulse rounded bg-surface-sunken" aria-hidden="true"></div>
          </div>
        }

        @case ('error') {
          <div>
            <h1 class="text-admin-page text-ink">
              {{ notFound() ? 'Restaurant not found' : 'This restaurant could not be loaded' }}
            </h1>
            <p class="mt-0.5 text-admin-meta text-ink-subtle tabular-figures">{{ id() }}</p>
          </div>
        }

        @default {
          <h1 class="text-admin-page text-ink">Restaurant</h1>
        }
      }

      <!-- The tabs stay mounted through every state so the frame does not jump, and so
           an operator who lands on a failure can still move within the workspace once
           the retry succeeds. -->
      <nav class="flex gap-1 border-b border-line" aria-label="Restaurant sections">
        @for (tab of tabs; track tab.path) {
          <a
            [routerLink]="tab.path === '' ? ['.'] : ['.', tab.path]"
            routerLinkActive="border-admin-accent text-ink"
            #active="routerLinkActive"
            [routerLinkActiveOptions]="{ exact: tab.path === '' }"
            [attr.aria-current]="active.isActive ? 'page' : null"
            class="-mb-px border-b-2 border-transparent px-3 py-2 text-admin-label
                   text-ink-muted hover:text-ink"
          >
            {{ tab.label }}
          </a>
        }
      </nav>
    </header>

    @switch (workspace.state()) {
      @case ('error') {
        <section class="rounded-lg bg-surface p-6 ring-1 ring-line">
          @if (notFound()) {
            <!-- A 404 is a real, renderable outcome: the restaurant is gone, or was
                 never there, or has been soft-deleted. It is NOT the same as the
                 service being unreachable, and it must not offer a pointless retry. -->
            <h2 class="text-admin-section text-ink">No such restaurant</h2>
            <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
              Nothing on this platform has that identifier. It may have been removed, or the
              link may be wrong.
            </p>
            <div class="mt-4">
              <a routerLink="/restaurants" [class]="secondaryActionClasses"
                >Back to Restaurants</a
              >
            </div>
          } @else {
            <h2 class="text-admin-section text-ink">This restaurant could not be loaded</h2>
            <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
              {{ workspace.failure()?.message }}
            </p>
            @if (workspace.failure()?.requestId; as requestId) {
              <p class="mt-2 text-admin-meta text-ink-subtle">
                Request ID <span class="tabular-figures">{{ requestId }}</span> — quote this if
                you report it.
              </p>
            }
            <div class="mt-4">
              <app-admin-button variant="primary" (pressed)="workspace.reload()"
                >Try again</app-admin-button
              >
            </div>
          }
        </section>
      }

      @default {
        <router-outlet />
      }
    }
  `,
})
export class RestaurantDetailPage {
  /** Bound from `/restaurants/:id` by withComponentInputBinding(). */
  readonly id = input.required<string>();

  protected readonly workspace = inject(RestaurantWorkspaceStore);

  protected readonly lifecycleLabel = lifecycleLabel;
  protected readonly lifecycleMeaning = lifecycleMeaning;
  protected readonly lifecycleVariant = lifecycleVariant;

  /** Shared with the button primitive so a navigating action cannot drift from it. */
  protected readonly primaryActionClasses = adminButtonClasses('primary');
  protected readonly secondaryActionClasses = adminButtonClasses('secondary');

  protected readonly notFound = computed(() => this.workspace.failure()?.kind === 'not-found');

  protected readonly tabs = [
    { path: '', label: 'Overview' },
    { path: 'readiness', label: 'Readiness' },
    { path: 'billing', label: 'Billing' },
    { path: 'support', label: 'Support' },
    { path: 'activity', label: 'Activity' },
  ];

  constructor() {
    // The ONE place the workspace's detail read is started. A tab that called this
    // would become a second owner of the same data — which is exactly the duplicate
    // request the store exists to prevent.
    //
    // `untracked` IS LOAD-BEARING, not tidiness. `load()` reads the store's own
    // signals to decide whether the id has actually changed, and it writes them; run
    // inside the effect's reactive context those reads become dependencies, and the
    // write re-triggers the effect that made it — an unbounded loop that presents as
    // a hung tab rather than an error. The only thing this effect may depend on is
    // the route's `:id`.
    effect(() => {
      const id = this.id();
      untracked(() => this.workspace.load(id));
    });
  }
}
