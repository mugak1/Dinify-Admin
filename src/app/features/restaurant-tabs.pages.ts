import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The five restaurant-detail tabs, as empty states.
 *
 * Each says what will live there and which step of §15 brings it, so the boundary of
 * this scaffold is legible from inside the running application rather than only from
 * a PR description.
 */

const PANEL =
  'rounded-lg bg-surface p-6 ring-1 ring-line';

@Component({
  selector: 'app-restaurant-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Overview</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        Will show a needs-attention block when anything blocks go-live, then owner and claim
        status, payment mode, subscription and trial end, an operational summary (last order,
        tables, dining areas), and the three or four most recent activity entries.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §9.1 — arrives with step 1.</p>
    </section>
  `,
})
export class RestaurantOverviewTab {
  protected readonly panel = PANEL;
}

@Component({
  selector: 'app-restaurant-readiness-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Readiness</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        Will show the go-live rules engine: restaurant setup (a published available item, an
        enabled table with a current QR, a completed test order), ownership (owner account
        claimed and go-live approval recorded), and commercial (subscription record, payment
        mode). Conditional rules apply before satisfaction is evaluated — a TIN is required
        only when the restaurant is VAT-registered, and PSP onboarding is irrelevant to a
        cash-only restaurant rather than a blocker it can never clear.
      </p>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        The owner-invitation state machine lives here too, beside the blocker it satisfies.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §10 and §14 — arrives with step 3.</p>
    </section>
  `,
})
export class RestaurantReadinessTab {
  protected readonly panel = PANEL;
}

@Component({
  selector: 'app-restaurant-billing-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Billing</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        Will show this restaurant's subscription and its invoices. Manual mark-paid is the only
        write, and it is a consequential one — visibly pending until the server has committed
        and audited it.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §8 — arrives with step 7.</p>
    </section>
  `,
})
export class RestaurantBillingTab {
  protected readonly panel = PANEL;
}

@Component({
  selector: 'app-restaurant-support-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Support</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        Will show this restaurant's support issues. The triage surface is being rebuilt natively
        on the admin plane — the old customer-plane endpoints were deleted in Phase 0.5 PR-A
        because their only gate was a role string.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §15 — arrives with step 6.</p>
    </section>
  `,
})
export class RestaurantSupportTab {
  protected readonly panel = PANEL;
}

@Component({
  selector: 'app-restaurant-activity-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Activity</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        Will show this restaurant's slice of the audit trail — the same read-only narrative view
        as the global one, filtered to this tenant. It is what answers "why is this restaurant
        suspended?" without a database session.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §12 — arrives with step 8.</p>
    </section>
  `,
})
export class RestaurantActivityTab {
  protected readonly panel = PANEL;
}
