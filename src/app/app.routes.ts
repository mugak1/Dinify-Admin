import { Routes } from '@angular/router';

import { authGuard, serviceUnavailableGuard } from './core/auth/auth.guard';
import { DEV_ROUTES } from './dev/dev-tools';
import { ActivityPage } from './features/activity.page';
import { HomePage } from './features/home.page';
import { LoginPage } from './features/login.page';
import { InvoicePage, ReceivablesPage } from './features/receivables.pages';
import { RestaurantWorkspaceStore } from './core/restaurants/restaurant-workspace.store';
import { RestaurantDetailPage } from './features/restaurant-detail.page';
import {
  RestaurantActivityTab,
  RestaurantBillingTab,
  RestaurantOverviewTab,
  RestaurantSupportTab,
} from './features/restaurant-tabs.pages';
import { RestaurantsPage } from './features/restaurants.page';
import { ServiceUnavailablePage } from './features/service-unavailable.page';
import { SupportIssuePage, SupportPage } from './features/support.pages';
import { ShellComponent } from './shell/shell.component';

/**
 * The URL scheme from spec §9.2 — meaningful, deep-linkable, refreshable, with
 * working browser Back.
 *
 *   /                                 /support
 *   /restaurants                      /support/:issueId
 *   /restaurants/new                  /receivables
 *   /restaurants/:id                  /receivables/:invoiceId
 *   /restaurants/:id/readiness        /activity
 *   /restaurants/:id/billing          /login
 *   /restaurants/:id/support          /unavailable
 *   /restaurants/:id/activity
 *
 * ── `/restaurants/new` IS DECLARED BEFORE `/restaurants/:id`, AND MUST STAY THERE ──
 *
 * The router matches in declaration order and `:id` matches ANY segment, so declared
 * the other way round the creation screen would never render — `new` would open the
 * workspace for a restaurant called "new", which 404s. It is a UI address only: the
 * API it talks to is `POST /restaurants/`, the collection route, and there is no
 * `/restaurants/new/` on the server. Not a sixth destination either (§9) — creation is
 * reached from the Restaurants directory and lives under it.
 *
 * ── THE DETAIL TABS ARE CHILDREN, NOT SIBLINGS ────────────────────────────────────
 *
 * `/restaurants/:id/*` nests under one `RestaurantDetailPage`, so the persistent
 * header §9.1 requires is genuinely persistent: it is not re-rendered per tab and
 * cannot drift between them. The operator always knows which tenant they are acting
 * on, which matters most in a delegated session with the restaurant portal open
 * alongside.
 *
 * ── LOGIN SITS OUTSIDE THE SHELL ──────────────────────────────────────────────────
 *
 * Nothing about the authenticated frame should render for an unauthenticated
 * operator — not the navigation, not an empty operator chip.
 *
 * ── AND SO DOES /unavailable ──────────────────────────────────────────────────────
 *
 * Neither is a DESTINATION — global navigation is still exactly five (§9). They are
 * the two states in which the operator has no session to work with, and they are
 * separate because they need opposite things from the operator: one asks for
 * credentials, the other must not.
 *
 * ── FILTERS GO IN THE QUERY STRING, NOT HERE ──────────────────────────────────────
 *
 * `/restaurants?status=onboarding&attention=true`. See `core/url/query-param.ts`.
 *
 * ── DEEP LINKS NEED THE SERVER'S HELP ─────────────────────────────────────────────
 *
 * Under `ng serve` the dev server already rewrites unknown paths to `index.html`, so
 * refreshing `/restaurants/abc/readiness` works. In production it requires an APACHE
 * SPA FALLBACK that serves `index.html` for unmatched paths WHILE EXCLUDING `/api` —
 * that is 0C's job. Until 0C ships, deep links work under `ng serve` only. See
 * CLAUDE.md.
 */
export const routes: Routes = [
  { path: 'login', component: LoginPage, title: 'Sign in · Dinify Admin' },

  {
    path: 'unavailable',
    component: ServiceUnavailablePage,
    title: 'Unavailable · Dinify Admin',
    // Guarded so a bookmarked URL cannot claim an outage that is not happening.
    canActivate: [serviceUnavailableGuard],
  },

  {
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: '', component: HomePage, title: 'Home · Dinify Admin' },

      { path: 'restaurants', component: RestaurantsPage, title: 'Restaurants · Dinify Admin' },
      // BEFORE `restaurants/:id` — see the class comment. Moving it below is a silent
      // break, not an error, which is why `app.routes.spec.ts` pins the order.
      // LAZY, like the legal pages in the sibling repo: creation is a rare, deliberate
      // act, and the screen (with the claim-code panel it renders) is the one feature
      // that has no business in the bundle every operator downloads to look at the
      // directory. Step 2G pushed the eager initial bundle past the 500 kB warning
      // budget; this is what brought it back.
      {
        path: 'restaurants/new',
        loadComponent: () =>
          import('./features/restaurant-create.page').then((m) => m.RestaurantCreatePage),
        title: 'Create restaurant · Dinify Admin',
      },
      {
        path: 'restaurants/:id',
        component: RestaurantDetailPage,
        title: 'Restaurant · Dinify Admin',
        /**
         * THE WORKSPACE'S DETAIL READ, scoped to this subtree.
         *
         * Provided HERE rather than at the root so exactly one instance exists per
         * open restaurant and it dies with the route. The parent loads it and every
         * tab reads it, which is what stops Overview issuing a second
         * `GET /restaurants/<id>/` merely because it is a child route — the §9.1
         * header and Overview are one screen, and two reads can disagree.
         */
        providers: [RestaurantWorkspaceStore],
        children: [
          { path: '', component: RestaurantOverviewTab },
          {
            path: 'readiness',
            // Lazy, for the bundle budget — see the docstring in the tab's own file.
            loadComponent: () =>
              import('./features/restaurant-readiness.tab').then((m) => m.RestaurantReadinessTab),
          },
          { path: 'billing', component: RestaurantBillingTab },
          { path: 'support', component: RestaurantSupportTab },
          { path: 'activity', component: RestaurantActivityTab },
        ],
      },

      { path: 'support', component: SupportPage, title: 'Support · Dinify Admin' },
      { path: 'support/:issueId', component: SupportIssuePage, title: 'Issue · Dinify Admin' },

      { path: 'receivables', component: ReceivablesPage, title: 'Receivables · Dinify Admin' },
      {
        path: 'receivables/:invoiceId',
        component: InvoicePage,
        title: 'Invoice · Dinify Admin',
      },

      { path: 'activity', component: ActivityPage, title: 'Activity · Dinify Admin' },

      // Empty in production — the module this comes from is file-replaced.
      ...DEV_ROUTES,
    ],
  },

  // Not a destination: a mistyped or retired URL lands on Home rather than on a blank
  // frame. Deliberately the only entry beyond the scheme above.
  { path: '**', redirectTo: '' },
];
