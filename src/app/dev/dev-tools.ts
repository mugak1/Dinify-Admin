import { Provider } from '@angular/core';
import { Routes } from '@angular/router';

import { environment } from '../../environments/environment';
import { ADMIN_AUTH } from '../core/auth/admin-auth.api';
import { RESTAURANT_API } from '../core/restaurants/restaurant.api';
import { MockAdminAuthApi } from './mock-admin-auth';
import { MockRestaurantApi } from './mock-restaurant-api';

/**
 * THE DEVELOPMENT SEAM. Two exports, and the production build never sees this file.
 *
 * `angular.json`'s production configuration FILE-REPLACES this module with
 * `dev-tools.prod.ts`, whose exports are empty. That is deliberately stronger than a
 * runtime flag or a tree-shaking assumption: the mock transport and the gallery are
 * not merely unreachable in production, they are not in the module graph at all,
 * because nothing in the production build imports the files that import them.
 *
 * `scripts/check-mock-isolation.mjs` then scans the built bundles for the two build
 * markers and fails if either appears — so the guarantee is CHECKED, not asserted.
 */

/**
 * Empty in the `live` serve configuration, so `ng serve --configuration=live` talks
 * to a real backend while keeping the gallery available.
 */
export const DEV_PROVIDERS: Provider[] = environment.useMockApi
  ? [
      { provide: ADMIN_AUTH, useClass: MockAdminAuthApi },
      { provide: RESTAURANT_API, useClass: MockRestaurantApi },
    ]
  : [];

/** Mounted inside the shell, so the gallery is reviewed in its real chrome. */
export const DEV_ROUTES: Routes = [
  {
    path: '__gallery',
    loadComponent: () => import('./gallery.page').then((m) => m.GalleryPage),
  },
];
