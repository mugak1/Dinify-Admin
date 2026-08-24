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
  paymentCollectionModeLabel,
  paymentCollectionModeNote,
  paymentTimingLabel,
  readinessBlockerLabel,
  readinessLabel,
  SUBSCRIPTION_TERMS_NOTE,
  subscriptionMethodLabel,
  subscriptionTermsLabel,
} from '../core/restaurants/restaurant.labels';
import { CommercialAxis } from '../core/restaurants/restaurant.model';
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

/**
 * When a commercial axis was decided, EAT-labelled (§16) — or null where there is no
 * decision to timestamp.
 *
 * Guarded on the VALUE rather than on `configured`, matching every other reader in this
 * slice: what is displayed is what is checked, so a server that ever sent the two
 * inconsistently would degrade rather than render a timestamp under "Not configured".
 */
function setAtLabel(axis: CommercialAxis<unknown> | undefined): string | null {
  if (!axis || axis.value === null || !axis.set_at) return null;
  return formatEat(axis.set_at);
}

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
               THE CANONICAL commercial OBJECT, and nothing else, above the fence.

               Three INDEPENDENT facts get three rows, because they are three separate
               decisions with three separate lifetimes and every partial combination is
               a real state. There is deliberately no combined "Commercial configured"
               verdict and no green success treatment: §10 asks a completed state to
               recede, and a recorded price is not an achievement.

               These rows read the same commercial object the DIRECTORY reads, through
               the same label functions — one read, one vocabulary, so the row and this
               header cannot disagree.

               THE LEGACY COLUMNS ARE BELOW THE FENCE and are never consulted here. Where
               they disagree with commercial — and payment_mode is frozen null while
               has_commercial_subscription is frozen false, so for any configured
               restaurant they DO — the canonical object wins. -->
          <section [class]="panel" aria-labelledby="commercial-heading">
            <h2 id="commercial-heading" class="text-admin-section text-ink">Commercial</h2>
            <dl class="mt-3 space-y-1.5">
              <!-- WHEN the diner pays, relative to eating. A service-model fact. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Payment timing</dt>
                <dd class="text-right">
                  <span [class]="definition">{{ paymentTiming() }}</span>
                  @if (paymentTimingSetAt(); as when) {
                    <!-- WHEN THE DECISION WAS RECORDED — named precisely, because this
                         is not when the terms took effect and not when anything was
                         agreed. -->
                    <span class="block text-admin-meta text-ink-subtle">Set {{ when }}</span>
                  }
                </dd>
              </div>

              <!-- WHO takes the money. A custody fact, independent of the row above. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Collection mode</dt>
                <dd class="text-right">
                  <span [class]="definition">{{ collectionMode() }}</span>
                  @if (collectionModeSetAt(); as when) {
                    <span class="block text-admin-meta text-ink-subtle">Set {{ when }}</span>
                  }
                </dd>
              </div>

              <!-- WHAT DINIFY HAS WRITTEN DOWN that this restaurant pays it. The price
                   and the recurrence themselves — never a status word. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Subscription terms</dt>
                <dd class="text-right">
                  <span [class]="definition">{{ subscriptionTerms() }}</span>
                  @if (termsEffectiveFrom(); as when) {
                    <span class="block text-admin-meta text-ink-subtle"
                      >Effective from {{ when }}</span
                    >
                  }
                  @if (termsRecordedAt(); as when) {
                    <!-- RECORDED, not agreed, signed, activated or paid. Dinify wrote
                         this down; nobody countersigned it. -->
                    <span class="block text-admin-meta text-ink-subtle">Recorded {{ when }}</span>
                  }
                </dd>
              </div>

              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Readiness</dt>
                <dd [class]="definition">{{ readiness() }}</dd>
              </div>
            </dl>

            @if (collectionNote(); as copy) {
              <!-- The one sentence each configured custody mode needs: offline is read
                   DOWN as cash-only or unfinished, psp_online is read UP as a provider
                   being connected. Both readings are wrong. -->
              <p [class]="note">{{ copy }}</p>
            }

            @if (hasSubscriptionTerms()) {
              <p [class]="note">{{ termsNote }}</p>
            }

            <!-- THE LEGACY BLOCK, BELOW A LITERAL FENCE. Kept because an operator
                 reconciling an old record will want these three columns, which do still
                 vary per restaurant — and kept unmistakably SUBORDINATE, because that is
                 the whole reason it is safe to keep at all.

                 It never overrides and never stands in for the canonical rows above:
                 nothing here is a fallback when the commercial state is unconfigured, and the
                 validity flag is a bare boolean that defaults true and that nothing
                 maintains. Calling it Paid would stop an operator chasing an invoice
                 that was never raised. -->
            <div class="mt-4 border-t border-line pt-3">
              <h3 class="text-admin-micro uppercase text-ink-subtle">Legacy record</h3>
              <p class="mt-1 max-w-prose text-admin-meta text-ink-subtle">
                Superseded columns, carried over from before the commercial domain existed.
                Kept for reconciliation only. Where these disagree with the commercial
                state above, the state above is authoritative.
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
  protected readonly termsNote = SUBSCRIPTION_TERMS_NOTE;
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

  // --- commercial (Step 3E.1) -----------------------------------------------------
  //
  // Pure projections of the canonical `commercial` object, exactly as the onboarding
  // block above projects `onboarding`. NOTHING HERE INFERS: no axis is derived from the
  // other, terms are never derived from either axis, and none of the three is ever
  // derived from a legacy field, from lifecycle state or from `is_test`. Where the
  // server says nothing, so does this.

  private readonly commercial = computed(() => this.restaurant()?.commercial ?? null);

  protected readonly paymentTiming = computed(() => {
    const summary = this.commercial();
    return summary ? paymentTimingLabel(summary.payment_timing.value) : NO_VALUE;
  });

  /**
   * Rendered only where the axis is CONFIGURED.
   *
   * The server nulls `set_at` alongside an unconfigured value, so this is belt and
   * braces — but a bare timestamp under "Not configured" would invite the reader to
   * attach it to a decision that was never made.
   */
  protected readonly paymentTimingSetAt = computed(() => setAtLabel(this.commercial()?.payment_timing));

  protected readonly collectionMode = computed(() => {
    const summary = this.commercial();
    return summary ? paymentCollectionModeLabel(summary.payment_collection_mode.value) : NO_VALUE;
  });

  protected readonly collectionModeSetAt = computed(() =>
    setAtLabel(this.commercial()?.payment_collection_mode),
  );

  protected readonly collectionNote = computed(() => {
    const summary = this.commercial();
    return summary ? paymentCollectionModeNote(summary.payment_collection_mode.value) : null;
  });

  protected readonly subscriptionTerms = computed(() => subscriptionTermsLabel(this.commercial()));

  /**
   * Guarded on `current` rather than on `configured`, like the label itself: what is
   * rendered is what is checked.
   */
  private readonly terms = computed(() => this.commercial()?.subscription_terms.current ?? null);

  protected readonly hasSubscriptionTerms = computed(() => this.terms() !== null);

  /** WHEN THE TERMS BECAME APPLICABLE. Not when they were written down. */
  protected readonly termsEffectiveFrom = computed(() => {
    const at = this.terms()?.effective_from;
    return at ? formatEat(at) : null;
  });

  /** WHEN DINIFY WROTE THEM DOWN. Never agreed, signed, activated or paid. */
  protected readonly termsRecordedAt = computed(() => {
    const at = this.terms()?.recorded_at;
    return at ? formatEat(at) : null;
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
        claimed and go-live approval recorded), and commercial.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        <!-- Rewritten for Step 3E.1. This described the commercial half as "subscription record,
             payment mode" and spoke of a cash-only restaurant — vocabulary that predates the
             commercial domain and that the portal no longer uses anywhere else. It names the
             three canonical facts instead, and states the offline consequence without turning
             either collection mode into a claim the platform cannot support. -->
        The commercial half evaluates the three facts Overview already reports, separately:
        payment timing recorded, payment collection mode recorded, and current subscription terms
        recorded. Conditional rules apply before satisfaction is evaluated — a TIN is required
        only when the restaurant is VAT-registered.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        Collection mode decides whether a payment provider is in scope at all. Where the
        restaurant collects the diner payment itself, provider readiness is NOT APPLICABLE rather
        than a blocker it could never clear — that mode is permanent and first-class, and the
        first commercial restaurant has to be able to go live in it.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        <!-- FAIL CLOSED, deliberately. An earlier draft of this paragraph said merchant readiness
             became a requirement "only once a real integration exists", which reads as a WAIVER:
             it would let a restaurant go live having chosen a collection path that cannot take a
             payment. The backend states the intended answer as "required but unavailable", which
             is a blocker, and readiness fails closed everywhere else in this system. -->
        Where Dinify is recorded as collecting through a provider, provider-authoritative merchant
        readiness is REQUIRED — and with no integration built, that requirement is required but
        UNAVAILABLE: nothing can satisfy it, so it blocks rather than being waived. There is still
        no provider, no merchant identity and no readiness verdict for this portal to report; what
        the engine will report is that the question cannot yet be answered.
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
        Will show what this restaurant is invoiced for its Dinify subscription, and whether those
        invoices have been paid.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        <!-- This used to say the subscription models did not exist. They do now, so the copy
             would have been a false statement about the platform sitting on the tab that most
             invites an operator to ask about money. What is still missing is narrower and worth
             naming precisely. -->
        The recorded subscription TERMS already exist and are shown on Overview — the recorded
        price and how often it recurs. Terms are only what Dinify has written down. They are not
        an invoice, not a payment, not evidence of account standing, and not proof that the owner
        agreed to them.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        What this tab needs is the part that does not exist yet: there is no invoice, no
        receivable and no collection path anywhere on the platform, so no restaurant has ever
        been billed for a subscription through this system.
      </p>
      <p class="mt-2 max-w-prose text-admin-body text-ink-muted">
        Manual mark-paid arrives with them, and it is a consequential write — visibly pending
        until the server has committed and audited it.
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
