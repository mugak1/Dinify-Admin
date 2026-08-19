/**
 * GLOBAL NAVIGATION IS FIVE DESTINATIONS AND NOTHING MORE (spec §9).
 *
 * ── THE RULE, NOT A NOTE ──────────────────────────────────────────────────────────
 *
 * One object dominates this portal: THE RESTAURANT. Nearly every Phase 1 task is
 * restaurant-scoped — readiness, lifecycle, owner claim, payment mode, subscription,
 * invoices, support issues, delegation, QR provisioning, audit history. If each of
 * those became a top-level destination the portal would fragment immediately, and the
 * operator would spend their day asking "which screen was that on" instead of doing
 * the work.
 *
 * So: Onboarding, Readiness, Lifecycle, QR, Delegation and Payments MUST NOT appear
 * here. They are things done TO a restaurant and live inside it.
 *
 * FUTURE CAPABILITY BECOMES ANOTHER RESTAURANT-DETAIL TAB, OR ANOTHER
 * NEEDS-ATTENTION CONDITION ON HOME — NOT A SIXTH SIDEBAR ITEM. That is the rule to
 * apply when the next feature lands, and it is the one this file exists to hold.
 *
 * Icons are inline SVG path data. There is no icon package in this repo and no
 * component library — see CLAUDE.md.
 */
export interface NavDestination {
  /** Router path, absolute from the shell root. */
  readonly path: string;
  readonly label: string;
  /** `d` for a single path in a 16×16 viewBox. */
  readonly icon: string;
  /** What this destination is for. Used as the link's accessible description. */
  readonly description: string;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    path: '/',
    label: 'Home',
    description: 'What needs your attention',
    icon: 'M8 1.6 1.8 6.4V14a.6.6 0 0 0 .6.6h3.4V10h4.4v4.6h3.4a.6.6 0 0 0 .6-.6V6.4Z',
  },
  {
    path: '/restaurants',
    label: 'Restaurants',
    description: 'Directory and restaurant workspaces',
    icon: 'M2 2h12v2.2a2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0Zm.8 4.9V14h4V10h2.4v4h4V6.9a3 3 0 0 1-2.6-.8 3 3 0 0 1-4 0 3 3 0 0 1-3.8.8Z',
  },
  {
    path: '/support',
    label: 'Support',
    description: 'Issue inbox across every restaurant',
    icon: 'M8 1.5a6.5 6.5 0 1 0 3.2 12.2l2.6.7-.7-2.6A6.5 6.5 0 0 0 8 1.5Zm-.8 9.2h1.6v1.6H7.2Zm.8-6.4c1.4 0 2.4.9 2.4 2.1 0 1-.5 1.5-1.3 2-.5.4-.6.6-.6 1H7c0-1 .3-1.4 1-1.9.6-.4.8-.6.8-1.1 0-.5-.4-.8-1-.8s-1 .4-1 1H5.4c0-1.4 1-2.3 2.6-2.3Z',
  },
  {
    path: '/receivables',
    label: 'Receivables',
    description: 'Subscription invoices and payments',
    icon: 'M3.2 1.4h9.6v13.2l-1.8-1.2-1.6 1.2-1.4-1.2-1.4 1.2-1.6-1.2-1.8 1.2ZM5 4.6h6v1.3H5Zm0 2.8h6v1.3H5Zm0 2.8h3.8v1.3H5Z',
  },
  {
    path: '/activity',
    label: 'Activity',
    description: 'Audit trail of every control-plane action',
    icon: 'M1.6 8.4h2.8l1.4-4.2 2.6 8.4 1.6-5 1 2.4h3.4v1.4h-4.4l-.6-1.4-1.8 5.6L5.4 7l-.6 1.8H1.6Z',
  },
];
