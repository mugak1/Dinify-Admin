import { Route, Routes } from '@angular/router';

import { routes } from './app.routes';
import { DEV_ROUTES as PROD_DEV_ROUTES } from './dev/dev-tools.prod';
import { DEV_ROUTES } from './dev/dev-tools';
import { NAV_DESTINATIONS } from './shell/navigation';

/**
 * The scheme this application serves, per spec §9.2, plus `/unavailable`. Fourteen
 * addresses, and each one is a contract: the needs-attention items on Home link INTO
 * them, so a rename is a broken link somewhere the operator was told to look.
 *
 * `/unavailable` is not a §9.2 destination and not a navigable one — it is the third
 * bootstrap outcome, and it exists because a login form is the wrong thing to show an
 * operator whose control plane is not answering.
 */
const EXPECTED_PATHS = [
  '/',
  '/activity',
  '/login',
  '/unavailable',
  '/receivables',
  '/receivables/:invoiceId',
  '/restaurants',
  '/restaurants/:id',
  '/restaurants/:id/activity',
  '/restaurants/:id/billing',
  '/restaurants/:id/readiness',
  '/restaurants/:id/support',
  '/support',
  '/support/:issueId',
];

/** Paths contributed by the development-only routes, absent from production builds. */
const DEV_PATHS = DEV_ROUTES.map((route) => `/${route.path}`);

/**
 * Deduplicated because a parent and its empty-path child serve the SAME address —
 * `/restaurants/:id` is both the detail component and its Overview tab.
 */
function servedPaths(): string[] {
  return [...new Set(paths(routes))].filter((path) => !DEV_PATHS.includes(path)).sort();
}

/** Flatten the config into the browser paths it actually serves. */
function paths(config: Routes, prefix = ''): string[] {
  const out: string[] = [];
  for (const route of config) {
    if (route.redirectTo !== undefined) continue;
    const segment = route.path ?? '';
    const full = segment ? `${prefix}/${segment}` : prefix;
    if (route.component || route.loadComponent) out.push(full === '' ? '/' : full);
    if (route.children) out.push(...paths(route.children, full));
  }
  return out;
}

function findRoute(config: Routes, path: string): Route | undefined {
  return config.find((route) => route.path === path);
}

/**
 * The URL scheme is spec §9.2, and it is a contract rather than an implementation
 * detail: the needs-attention items on Home link INTO these addresses, so a rename is
 * a broken link somewhere the operator was told to look.
 */
describe('app routes', () => {
  it('serves exactly the §9.2 URL scheme', () => {
    expect(servedPaths()).toEqual([...EXPECTED_PATHS].sort());
  });

  it('adds nothing beyond that scheme except the development-only routes', () => {
    // This spec compiles against the DEVELOPMENT environment, so the gallery route is
    // present here. Asserting the delta explicitly is what stops a real route being
    // added under cover of "the dev routes make the count wrong".
    const all = [...new Set(paths(routes))].sort();
    expect(all).toEqual([...EXPECTED_PATHS, ...DEV_PATHS].sort());
    expect(DEV_PATHS).toEqual(['/__gallery']);
  });

  it('contributes NOTHING in a production build', () => {
    // `dev-tools.prod.ts` is what `angular.json` file-replaces `dev-tools.ts` with, so
    // this is the exported shape the production module graph actually sees. The
    // built-output half of the proof is scripts/check-mock-isolation.mjs.
    expect(PROD_DEV_ROUTES).toEqual([]);
  });

  it('keeps /login OUTSIDE the shell', () => {
    // Nothing about the authenticated frame should render for an unauthenticated
    // operator — not the navigation, not an empty operator chip.
    const login = findRoute(routes, 'login');
    expect(login).toBeDefined();
    expect(login?.canActivate ?? []).toEqual([]);

    const shell = findRoute(routes, '');
    expect(shell?.canActivate?.length).toBe(1);
  });

  it('keeps /unavailable outside the shell, and gated to the state it names', () => {
    // Outside, because there is no session to render a frame around. Gated, because a
    // bookmarked URL must not claim an outage while the service is answering — that is
    // the same confident false statement as a dead backend reading "Invalid
    // credentials.", arriving from the other side.
    const unavailable = findRoute(routes, 'unavailable');
    expect(unavailable?.component).toBeDefined();
    expect(unavailable?.canActivate?.length).toBe(1);
  });

  it('guards every authenticated destination through the shell', () => {
    const shell = findRoute(routes, '');
    expect(shell?.children?.length).toBeGreaterThan(0);
    for (const child of shell?.children ?? []) {
      expect(child.canActivate).withContext(child.path ?? '(root)').toBeUndefined();
    }
    // One guard on the parent, rather than twelve that can drift apart.
    expect(shell?.canActivate?.length).toBe(1);
  });

  it('nests the restaurant tabs so the §9.1 header is genuinely persistent', () => {
    const shell = findRoute(routes, '');
    const detail = findRoute(shell?.children ?? [], 'restaurants/:id');

    expect(detail?.component).withContext('one component owns the header').toBeDefined();
    expect((detail?.children ?? []).map((child) => child.path).sort()).toEqual(
      ['', 'activity', 'billing', 'readiness', 'support'].sort(),
    );
  });

  it('falls back to Home rather than a blank frame', () => {
    const wildcard = routes.find((route) => route.path === '**');
    expect(wildcard?.redirectTo).toBe('');
  });

  /**
   * Spec §9: GLOBAL NAVIGATION IS FIVE DESTINATIONS AND NOTHING MORE.
   *
   * Onboarding, Readiness, Lifecycle, QR, Delegation and Payments are things done TO
   * a restaurant and live inside it. Future capability becomes another
   * restaurant-detail tab or another needs-attention condition — not a sixth item.
   */
  it('exposes exactly five global destinations, and they all resolve', () => {
    expect(NAV_DESTINATIONS.length).toBe(5);
    expect(NAV_DESTINATIONS.map((item) => item.label)).toEqual([
      'Home',
      'Restaurants',
      'Support',
      'Receivables',
      'Activity',
    ]);

    const served = new Set(paths(routes));
    for (const item of NAV_DESTINATIONS) {
      expect(served.has(item.path)).withContext(item.path).toBeTrue();
    }
  });

  it('keeps restaurant-scoped capability OUT of global navigation', () => {
    const labels = NAV_DESTINATIONS.map((item) => item.label.toLowerCase());
    for (const forbidden of ['onboarding', 'readiness', 'lifecycle', 'qr', 'delegation', 'payments']) {
      expect(labels).withContext(forbidden).not.toContain(forbidden);
    }
  });
});
