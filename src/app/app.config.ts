import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

import { csrfInterceptor } from './core/api/csrf.interceptor';
import { errorClassifierInterceptor } from './core/api/error.interceptor';
import { ADMIN_AUTH } from './core/auth/admin-auth.api';
import { AdminAuthHttp } from './core/auth/admin-auth.http';
import { AdminAuthService } from './core/auth/admin-auth.service';
import { RESTAURANT_API } from './core/restaurants/restaurant.api';
import { RestaurantHttp } from './core/restaurants/restaurant.http';
import { DEV_PROVIDERS } from './dev/dev-tools';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    /**
     * ZONE-BASED change detection, matching Dinify-Frontend.
     *
     * Nothing in this repo depends on zone behaviour — no `NgZone.run`, no
     * `setTimeout` used to force a tick, every component `OnPush` and every piece of
     * state a signal — so flipping to `provideZonelessChangeDetection()` is a
     * one-line provider swap when the sibling makes the same move.
     */
    provideZoneChangeDetection(),

    provideRouter(
      routes,
      // Route parameters bind straight to component `input()`s — `:id` on the
      // restaurant detail page, `:issueId`, `:invoiceId`. No manual snapshot reads.
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),

    /**
     * INTERCEPTOR ORDER IS LOAD-BEARING. The classifier is FIRST so that when it
     * replays a request — after a CSRF re-bootstrap, or after a successful
     * re-elevation — the replay re-enters the CSRF interceptor and picks up the
     * CURRENT cookie. Registered the other way round, a retry after a CSRF
     * re-bootstrap would carry the very token it had just been refused for, and the
     * bounded retry would spend itself failing identically.
     */
    provideHttpClient(withInterceptors([errorClassifierInterceptor, csrfInterceptor])),

    /**
     * The real transports. `DEV_PROVIDERS` follows, so a development build overrides
     * them with the mocks — later providers win — and the production build has no
     * mock to override with, because `dev-tools.ts` is file-replaced.
     *
     * Both ports are registered here rather than at a route, so there is one answer
     * to "what talks to the server" and a screen cannot quietly acquire its own.
     */
    { provide: ADMIN_AUTH, useClass: AdminAuthHttp },
    { provide: RESTAURANT_API, useClass: RestaurantHttp },
    ...DEV_PROVIDERS,

    /**
     * THE BOOTSTRAP READ, before the shell renders. `GET /auth/session/` decides
     * authenticated-or-not AND is one of only two places the server issues the CSRF
     * cookie, so running it first guarantees the cookie exists before any write can
     * be attempted. See `AdminAuthService.bootstrap`.
     */
    provideAppInitializer(() => inject(AdminAuthService).bootstrap()),
  ],
};
