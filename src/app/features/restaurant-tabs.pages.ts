import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { formatEat } from '../core/formatting/time';
import {
  activityActionLabel,
  activityResultIsNotable,
  activityResultLabel,
  NO_VALUE,
  ONBOARDING_UNTRACKED_NOTE,
  onboardingSourceLabel,
  onboardingSourceNote,
  orderStatusLabel,
  ownerControlEvidenceLabel,
  ownerControlIsNotable,
  ownerControlLabel,
  ownerControlNote,
  ownerInvitationIsNotable,
  ownerInvitationLabel,
  ownerRelationshipIsNotable,
  ownerRelationshipLabel,
  ownerRelationshipNote,
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

/**
 * The same row, for a value an operator has to look at.
 *
 * §16's warning hue means "careful", not "broken", and there is deliberately no
 * matching success treatment: §10 asks a completed state to RECEDE. `consistent` and
 * `Established` render as ordinary values, and nothing on this screen is green.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL (§22). Every notable value here is a phrase that
 * reads as a problem on its own — "Stale evidence", "Owner mismatch", "Expired" — and
 * each is accompanied by prose saying what it means.
 */
const DEFINITION_NOTABLE = 'text-admin-body text-admin-warning';
const NOTE = 'mt-2 max-w-prose text-admin-meta text-ink-subtle';
const NOTE_NOTABLE = 'mt-2 max-w-prose text-admin-meta text-admin-warning';

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
               WHO the owner is: identity, contact and account state. Nothing about
               claims, control or invitations.

               It used to carry an "Owner claim" row reading "Not tracked yet", from
               the compatibility aliases owner.claim_tracked / owner.claim_status.
               Step 2C made that both wrong and redundant — wrong because a
               legacy-adopted tenant IS tracked and its control reads "Not established",
               which is not the same statement, and redundant because the Onboarding
               panel now answers it properly. Two panels answering one question is how a
               screen starts disagreeing with itself, so this one stopped. -->
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
              </dl>
            } @else {
              <p class="mt-2 text-admin-body text-ink-muted">
                No owner account is attached to this restaurant.
              </p>
            }
          </section>

          <!-- B2. ONBOARDING ───────────────────────────────────────────────────────
               THE CANONICAL PRESENTATION of the Step 2C projection, beside Owner
               because the two are read together and apart from it because they answer
               different questions.

               FIVE ROWS, AND THEY STAY FIVE. Provenance, when the admin record
               appeared, the structural owner check, whether control of the CURRENT
               owner is established, and the invitation. Collapsing them into one
               "Onboarding complete" status would fuse facts that routinely disagree:
               a restaurant can be consistent and uncontrolled, or controlled by an
               attestation that no longer applies.

               EVERY VALUE IS THE SERVER'S. Nothing here is inferred, defaulted or
               strengthened, and there is no writer anywhere in this panel — no adopt,
               no attest, no invite, no resend. Reading the truth is this slice. -->
          <section [class]="panel" aria-labelledby="onboarding-heading">
            <h2 id="onboarding-heading" class="text-admin-section text-ink">Onboarding</h2>
            <dl class="mt-3 space-y-1.5">
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Source</dt>
                <dd [class]="definition">{{ onboardingSource() }}</dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <!-- Named for what it is. NOT "Created" — for a pre-existing
                     restaurant this instant is long after it started trading. The
                     restaurant's own creation date is a different field. -->
                <dt [class]="term">Recorded in Admin</dt>
                <dd [class]="definition">{{ recordedAt() }}</dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Owner relationship</dt>
                <dd [class]="ownerRelationshipNotable() ? definitionNotable : definition">
                  {{ ownerRelationship() }}
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Owner control</dt>
                <dd [class]="ownerControlNotable() ? definitionNotable : definition">
                  {{ ownerControl() }}
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Invitation</dt>
                <dd [class]="invitationNotable() ? definitionNotable : definition">
                  {{ invitation() }}
                </dd>
              </div>
            </dl>

            <!-- The explanatory copy, in the order of the rows it explains. Each line
                 is a sentence about ONE row; they are never joined, because "how this
                 restaurant got here" and "nobody has proved they control it" are
                 different facts an operator acts on differently. -->
            @if (untracked()) {
              <p [class]="note">{{ untrackedNote }}</p>
            } @else {
              @if (sourceNote(); as copy) {
                <p [class]="note">{{ copy }}</p>
              }

              @if (relationshipNote(); as copy) {
                <p [class]="noteNotable">{{ copy }}</p>
              }

              <!-- The EVIDENCE line. It names what established control and when —
                   an administrator's attestation and an owner's redemption are
                   different acts, and the portal never describes one as the other. -->
              @if (evidenceLabel(); as evidence) {
                <p [class]="ownerControlNotable() ? noteNotable : note">
                  {{ evidence }}
                  @if (evidenceAt(); as at) {
                    <span aria-hidden="true"> · </span>
                    <span>{{ at }}</span>
                  }
                </p>
              }

              @if (controlNote(); as copy) {
                <p [class]="ownerControlNotable() ? noteNotable : note">{{ copy }}</p>
              }
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
  protected readonly definitionNotable = DEFINITION_NOTABLE;
  protected readonly note = NOTE;
  protected readonly noteNotable = NOTE_NOTABLE;
  protected readonly noValue = NO_VALUE;
  protected readonly untrackedNote = ONBOARDING_UNTRACKED_NOTE;

  protected readonly blockerLabel = readinessBlockerLabel;
  protected readonly orderStatus = orderStatusLabel;
  protected readonly actionLabel = activityActionLabel;
  protected readonly resultLabel = activityResultLabel;
  protected readonly resultIsNotable = activityResultIsNotable;
  protected readonly subscriptionMethod = subscriptionMethodLabel;
  protected readonly time = formatEat;

  // --- onboarding (Step 2C) -------------------------------------------------------
  //
  // Every one of these is a projection of a value the server already sent. There is no
  // client-side inference anywhere below: the panel never derives control from the
  // relationship, never derives an invitation state from the source, and never fills a
  // missing value with a friendlier one. Where the server says nothing, so does this.

  private readonly onboarding = computed(() => this.restaurant()?.onboarding ?? null);

  /** The domain holds no record. Distinct from every evaluated state — see the labels. */
  protected readonly untracked = computed(() => this.onboarding()?.tracked === false);

  protected readonly onboardingSource = computed(() => {
    const summary = this.onboarding();
    return summary ? onboardingSourceLabel(summary.source) : NO_VALUE;
  });

  protected readonly sourceNote = computed(() => {
    const summary = this.onboarding();
    return summary ? onboardingSourceNote(summary.source) : null;
  });

  /** EAT-labelled like every other timestamp, and `—` when there is none. */
  protected readonly recordedAt = computed(() => formatEat(this.onboarding()?.recorded_at));

  protected readonly ownerRelationship = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerRelationshipLabel(summary.owner_relationship.status) : NO_VALUE;
  });

  protected readonly relationshipNote = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerRelationshipNote(summary.owner_relationship.status) : null;
  });

  protected readonly ownerRelationshipNotable = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerRelationshipIsNotable(summary.owner_relationship.status) : false;
  });

  protected readonly ownerControl = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlLabel(summary.owner_control.status) : NO_VALUE;
  });

  protected readonly controlNote = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlNote(summary.owner_control.status) : null;
  });

  protected readonly ownerControlNotable = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlIsNotable(summary.owner_control.status) : false;
  });

  protected readonly evidenceLabel = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlEvidenceLabel(summary.owner_control.evidence) : null;
  });

  /**
   * Rendered only beside a named evidence. A bare timestamp with nothing to attach it
   * to would invite the reader to attach it to whatever row is nearest.
   */
  protected readonly evidenceAt = computed(() => {
    const at = this.onboarding()?.owner_control.evidence_at;
    return at ? formatEat(at) : null;
  });

  protected readonly invitation = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerInvitationLabel(summary.invitation.status) : NO_VALUE;
  });

  protected readonly invitationNotable = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerInvitationIsNotable(summary.invitation.status) : false;
  });

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
