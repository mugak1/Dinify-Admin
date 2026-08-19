import { Routes } from '@angular/router';

import { authGuard } from './core/auth/auth.guard';
import { DEV_ROUTES } from './dev/dev-tools';
import { ActivityPage } from './features/activity.page';
import { HomePage } from './features/home.page';
import { LoginPage } from './features/login.page';
import { InvoicePage, ReceivablesPage } from './features/receivables.pages';
import { RestaurantDetailPage } from './features/restaurant-detail.page';
import {
  RestaurantActivityTab,
  RestaurantBillingTab,
  RestaurantOverviewTab,
  RestaurantReadinessTab,
  RestaurantSupportTab,
} from './features/restaurant-tabs.pages';
import { RestaurantsPage } from './features/restaurants.page';
import { SupportIssuePage, SupportPage } from './features/support.pages';
import { ShellComponent } from './shell/shell.component';

/**
 * The URL scheme from spec §9.2 — meaningful, deep-linkable, refreshable, with
 * working browser Back.
 *
 *   /                                 /support
 *   /restaurants                      /support/:issueId
 *   /restaurants/:id                  /receivables
 *   /restaurants/:id/readiness        /receivables/:invoiceId
 *   /restaurants/:id/billing          /activity
 *   /restaurants/:id/support          /login
 *   /restaurants/:id/activity
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
    path: '',
    component: ShellComponent,
    canActivate: [authGuard],
    children: [
      { path: '', component: HomePage, title: 'Home · Dinify Admin' },

      { path: 'restaurants', component: RestaurantsPage, title: 'Restaurants · Dinify Admin' },
      {
        path: 'restaurants/:id',
        component: RestaurantDetailPage,
        title: 'Restaurant · Dinify Admin',
        children: [
          { path: '', component: RestaurantOverviewTab },
          { path: 'readiness', component: RestaurantReadinessTab },
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
