import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { formatEat } from '../core/formatting/time';
import {
  activityActionLabel,
  activityResultIsNotable,
  activityResultLabel,
  NO_VALUE,
  orderStatusLabel,
  paymentModeLabel,
  readinessBlockerLabel,
  readinessLabel,
  subscriptionMethodLabel,
} from '../core/restaurants/restaurant.labels';
import { RestaurantWorkspaceStore } from '../core/restaurants/restaurant-workspace.store';
import { StatusPillComponent } from '../ui/status-pill.component';

/**
 * The five restaurant-detail tabs.
 *
 * OVERVIEW IS REAL (spec §9.1, step 1). The other four state what will live there and
 * which step of §15 brings it, so the boundary of this slice is legible from inside
 * the running application rather than only from a PR description. None of them
 * duplicates Overview's data to look busier: a placeholder that shows real numbers is
 * a placeholder an operator will start trusting as the feature.
 */

const PANEL = 'rounded-lg bg-surface p-6 ring-1 ring-line';

/** A definition-list row. §16 asks for density, not four oversized KPI cards. */
const TERM = 'text-admin-label text-ink-muted';
const DEFINITION = 'text-admin-body text-ink';

@Component({
  selector: 'app-restaurant-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, StatusPillComponent],
  template: `
    @if (restaurant(); as data) {
      <div class="space-y-4">
        <!-- A. NEEDS ATTENTION ─────────────────────────────────────────────────────
             Prominent only when there IS something. §10 asks for the eye to be drawn
             to what remains, which is why there is no green "everything good" panel
             on the other branch: a completed state should recede, not celebrate. -->
        @if (data.needs_attention) {
          <section
            class="rounded-lg bg-admin-warning-soft p-4 ring-1 ring-inset ring-admin-warning/25"
            aria-labelledby="attention-heading"
          >
            <h2 id="attention-heading" class="text-admin-section text-ink">
              Needs attention
            </h2>
            <ul class="mt-2 space-y-1">
              @for (blocker of data.readiness.blockers; track blocker) {
                <!-- The machine code is translated. An operator should never be shown
                     a raw snake_case blocker, and "not configured" is a statement
                     about the CHECKLIST, not about this restaurant failing one. -->
                <li class="text-admin-body text-ink">{{ blockerLabel(blocker) }}</li>
              } @empty {
                <li class="text-admin-body text-ink">
                  This restaurant is not yet ready to go live.
                </li>
              }
            </ul>
            <p class="mt-3">
              <!-- Addressed absolutely from the restaurant this tab is showing.
                   A relative link from an EMPTY-PATH child resolves against the
                   parent's parent: a dot-dot here lands on /restaurants, not on
                   the restaurant's readiness tab. -->
              <a
                [routerLink]="['/restaurants', data.id, 'readiness']"
                class="text-admin-label text-admin-accent hover:underline"
                >Open readiness</a
              >
            </p>
          </section>
        }

        <div class="grid gap-4 md:grid-cols-2">
          <!-- B. OWNER ─────────────────────────────────────────────────────────────
               Safe contact fields only, plus the claim state the backend explicitly
               says it does not track. An account existing is not a claim. -->
          <section [class]="panel" aria-labelledby="owner-heading">
            <h2 id="owner-heading" class="text-admin-section text-ink">Owner</h2>
            @if (data.owner; as owner) {
              <dl class="mt-3 space-y-1.5">
                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Name</dt>
                  <dd [class]="definition">{{ owner.name ?? noValue }}</dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Email</dt>
                  <dd [class]="definition">{{ owner.email ?? noValue }}</dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Phone</dt>
                  <dd [class]="definition + ' tabular-figures'">{{ owner.phone_number ?? noValue }}</dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Account</dt>
                  <dd [class]="definition">{{ owner.is_active ? 'Active' : 'Deactivated' }}</dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Owner claim</dt>
                  <dd [class]="definition">
                    {{ owner.claim_tracked ? (owner.claim_status ?? noValue) : 'Not tracked yet' }}
                  </dd>
                </div>
              </dl>
              @if (!owner.claim_tracked) {
                <p class="mt-2 max-w-prose text-admin-meta text-ink-subtle">
                  There is no owner-invitation record yet, so whether this owner has claimed
                  their own account is not something the platform can answer.
                </p>
              }
            } @else {
              <p class="mt-2 text-admin-body text-ink-muted">
                No owner account is attached to this restaurant.
              </p>
            }
          </section>

          <!-- C + D. COMMERCIAL ─────────────────────────────────────────────────────
               Payment mode and subscription, both reported as the backend reports
               them. The legacy columns appear as LEGACY and are never restated as a
               billing status: the validity flag is a bare boolean nothing maintains,
               and calling it Paid would stop an operator chasing an invoice that was
               never raised. -->
          <section [class]="panel" aria-labelledby="commercial-heading">
            <h2 id="commercial-heading" class="text-admin-section text-ink">Commercial</h2>
            <dl class="mt-3 space-y-1.5">
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Payment mode</dt>
                <dd [class]="definition">{{ paymentMode() }}</dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Subscription</dt>
                <dd [class]="definition">
                  {{
                    data.subscription.has_commercial_subscription ? 'Active' : 'Not configured'
                  }}
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Readiness</dt>
                <dd [class]="definition">{{ readiness() }}</dd>
              </div>
            </dl>

            @if (!data.payment_mode_configured) {
              <p class="mt-2 max-w-prose text-admin-meta text-ink-subtle">
                No commercial payment mode is recorded for this restaurant yet.
              </p>
            }

            <!-- The legacy block, clearly fenced off. Shown because an operator
                 reconciling an old record will want it, labelled so nobody mistakes
                 it for the commercial subscription that does not exist. -->
            <div class="mt-4 border-t border-line pt-3">
              <h3 class="text-admin-micro uppercase text-ink-subtle">Legacy record</h3>
              <p class="mt-1 max-w-prose text-admin-meta text-ink-subtle">
                Columns carried over from before subscriptions were modelled. Not evidence
                that any invoice exists.
              </p>
              <dl class="mt-2 space-y-1.5">
                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Validity flag</dt>
                  <dd [class]="definition">
                    {{ data.subscription.legacy_validity_flag ? 'Set' : 'Not set' }}
                  </dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Expiry</dt>
                  <dd [class]="definition">{{ legacyExpiry() }}</dd>
                </div>

                <div class="flex items-baseline justify-between gap-4">
                  <dt [class]="term">Billing method</dt>
                  <dd [class]="definition">
                    {{ subscriptionMethod(data.subscription.preferred_method) }}
                  </dd>
                </div>
              </dl>
            </div>
          </section>

          <!-- E. OPERATIONS ────────────────────────────────────────────────────────
               Floor facts, compact. Not a metrics dashboard: §11 puts metrics last,
               and Overview is an operator summary. -->
          <section [class]="panel" aria-labelledby="operations-heading">
            <h2 id="operations-heading" class="text-admin-section text-ink">Operations</h2>
            <dl class="mt-3 space-y-1.5">
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Tables</dt>
                <dd [class]="definition + ' tabular-figures'">{{ data.operations.table_count }}</dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Usable tables</dt>
                <dd [class]="definition + ' tabular-figures'">
                  {{ data.operations.usable_table_count }}
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Dining areas</dt>
                <dd [class]="definition + ' tabular-figures'">
                  {{ data.operations.dining_area_count }}
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Open support issues</dt>
                <dd [class]="definition + ' tabular-figures'">
                  {{ data.support.open_issue_count }}
                </dd>
              </div>
            </dl>

            <div class="mt-4 border-t border-line pt-3">
              <h3 class="text-admin-micro uppercase text-ink-subtle">Latest order</h3>
              @if (data.operations.latest_order; as order) {
                <div class="mt-1 flex flex-wrap items-center gap-2">
                  <span class="text-admin-body text-ink">{{
                    orderStatus(order.order_status)
                  }}</span>
                  @if (order.is_test) {
                    <!-- A TEST order is operationally real and commercially invisible.
                         Marked, because "a rehearsal happened" and "a sale happened"
                         are different facts. -->
                    <app-status-pill variant="test" />
                  }
                </div>
                <p class="mt-1 text-admin-meta text-ink-subtle">{{ orderTime() }}</p>
              } @else {
                <p class="mt-1 text-admin-body text-ink-muted">No orders yet.</p>
              }
            </div>
          </section>

          <!-- F. RECENT ACTIVITY ───────────────────────────────────────────────────
               The last few control-plane actions, as narrative. The full audit surface
               (§12, step 8) is where request ids, before/after state and source IP
               belong — this endpoint deliberately does not return them. -->
          <section [class]="panel" aria-labelledby="activity-heading">
            <h2 id="activity-heading" class="text-admin-section text-ink">Recent activity</h2>
            @if (data.recent_activity.length) {
              <ul class="mt-3 space-y-3">
                @for (entry of data.recent_activity; track entry.id) {
                  <li class="border-b border-line pb-3 last:border-b-0 last:pb-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-admin-body text-ink">{{ actionLabel(entry.action) }}</span>
                      @if (resultIsNotable(entry.result)) {
                        <span class="text-admin-meta text-admin-warning">{{
                          resultLabel(entry.result)
                        }}</span>
                      }
                    </div>
                    <p class="mt-0.5 text-admin-meta text-ink-subtle">
                      {{ entry.actor ?? 'Unattributed' }}
                      <span aria-hidden="true"> · </span>
                      {{ time(entry.timestamp) }}
                    </p>
                  </li>
                }
              </ul>
            } @else {
              <p class="mt-2 text-admin-body text-ink-muted">
                No control-plane activity recorded for this restaurant.
              </p>
            }
          </section>
        </div>
      </div>
    } @else if (workspace.loading()) {
      <section [class]="panel" aria-busy="true">
        <p class="text-admin-body text-ink-muted">Loading overview…</p>
      </section>
    }
  `,
})
export class RestaurantOverviewTab {
  /**
   * The SAME store instance the header uses — provided on the `/restaurants/:id`
   * route. Overview issues no request of its own: one screen, one read.
   */
  protected readonly workspace = inject(RestaurantWorkspaceStore);
  protected readonly restaurant = this.workspace.detail;

  protected readonly panel = PANEL;
  protected readonly term = TERM;
  protected readonly definition = DEFINITION;
  protected readonly noValue = NO_VALUE;

  protected readonly blockerLabel = readinessBlockerLabel;
  protected readonly orderStatus = orderStatusLabel;
  protected readonly actionLabel = activityActionLabel;
  protected readonly resultLabel = activityResultLabel;
  protected readonly resultIsNotable = activityResultIsNotable;
  protected readonly subscriptionMethod = subscriptionMethodLabel;
  protected readonly time = formatEat;

  protected readonly readiness = computed(() => {
    const data = this.restaurant();
    return data ? readinessLabel(data.readiness) : NO_VALUE;
  });

  protected readonly paymentMode = computed(() => {
    const data = this.restaurant();
    return data ? paymentModeLabel(data) : NO_VALUE;
  });

  /** Always EAT-labelled (§16) — never the browser's clock, never an unlabelled one. */
  protected readonly legacyExpiry = computed(() =>
    formatEat(this.restaurant()?.subscription.legacy_expiry_at),
  );

  protected readonly orderTime = computed(() =>
    formatEat(this.restaurant()?.operations.latest_order?.created_at),
  );
}

@Component({
  selector: 'app-restaurant-readiness-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="panel">
      <h2 class="text-admin-section text-ink">Readiness</h2>
      <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
        The go-live rules engine is not built yet. The server's readiness check currently fails
        closed for every restaurant — it reports one blocker, "readiness not configured", and
        refuses the onboarding-to-live transition on every path. That is a deliberate safety
        state, not a fault with any particular restaurant.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        This tab will show the real checklist: restaurant setup (a published available item, an
        enabled table with a current QR, a completed test order), ownership (owner account
        claimed and go-live approval recorded), and commercial (subscription record, payment
        mode). Conditional rules apply before satisfaction is evaluated — a TIN is required only
        when the restaurant is VAT-registered, and PSP onboarding is irrelevant to a cash-only
        restaurant rather than a blocker it can never clear.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
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
        Will show this restaurant's subscription and its invoices. The commercial subscription
        models do not exist yet, which is why Overview reports the subscription as not configured
        and shows the legacy columns as legacy.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        Manual mark-paid is the only write, and it is a consequential one — visibly pending until
        the server has committed and audited it.
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
        Will show this restaurant's support issues. Overview reports how many are open; reading
        and triaging them needs a surface that is being rebuilt natively on the admin plane — the
        old customer-plane endpoints were deleted in Phase 0.5 PR-A because their only gate was a
        role string.
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
        as the global one, filtered to this tenant, with request id, delegation id, before and
        after state and source IP on expanding a row. Overview shows only the most recent few
        entries and deliberately carries none of that forensic detail.
      </p>
      <p class="mt-3 text-admin-meta text-ink-subtle">Spec §12 — arrives with step 8.</p>
    </section>
  `,
})
export class RestaurantActivityTab {
  protected readonly panel = PANEL;
}
