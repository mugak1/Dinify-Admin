import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminServiceStatus } from '../core/api/service-status';
import { extractErrorMessage, extractFieldErrors } from '../core/api/error-message';
import { classifyTransportFailure, extractRequestId } from '../core/api/transport-failure';
import { ElevationAbandonedError, ElevationCancelledError } from '../core/auth/elevation.service';
import { formatEat } from '../core/formatting/time';
import {
  activityActionLabel,
  activityResultIsNotable,
  activityResultLabel,
  billingIntervalLabel,
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
  subscriptionAmountLabel,
  subscriptionMethodLabel,
  subscriptionTermsLabel,
} from '../core/restaurants/restaurant.labels';
import { RESTAURANT_API } from '../core/restaurants/restaurant.api';
import {
  CommercialAxis,
  CommercialSummary,
  PaymentCollectionMode,
  PaymentTiming,
} from '../core/restaurants/restaurant.model';
import { RestaurantWorkspaceStore } from '../core/restaurants/restaurant-workspace.store';
import { StatusPillComponent } from '../ui/status-pill.component';
import { AdminButtonComponent } from '../ui/button.component';
import {
  CommercialAxisEditorComponent,
  CommercialAxisOption,
  CommercialAxisSubmission,
} from './commercial-axis-editor.component';
import {
  SubscriptionTermsEditorComponent,
  SubscriptionTermsPrefill,
  SubscriptionTermsSubmission,
} from './subscription-terms-editor.component';
import {
  SubscriptionTermsEndComponent,
  SubscriptionTermsEndSubmission,
} from './subscription-terms-end.component';

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

/**
 * The HTTP status of a failed write, or null.
 *
 * DUCK-TYPED, for the same reason `classifyTransportFailure` is: the development mock
 * throws `MockHttpError`, not `HttpErrorResponse`, so an `instanceof` check here would
 * make the 409 and 404 branches dead code in the one mode this work is reviewed in
 * before a deploy exists. Mirrors `load-failure.ts`.
 */
/** Which commercial editor is open. One slot, five operations. */
type CommercialEditor = 'timing' | 'collection' | 'record' | 'replace' | 'end';

/**
 * What one commercial write says about its own outcomes.
 *
 * `unchanged` IS SUCCESS COPY, not failure copy. The server answers a same-state request
 * with `changed: false` so a lost response followed by an exact retry is not a false
 * conflict and does not re-stamp attribution — so the sentence says nothing moved, and
 * never describes a no-op as a new decision.
 */
interface CommercialWriteCopy {
  /** After `changed: true`. */
  readonly recorded: string;
  /** After `changed: false`. */
  readonly unchanged: string;
  /**
   * The conflict half of a 409 sentence.
   *
   * A function because the two families genuinely differ. An axis has ONE conflict and
   * the panel says so in its own words. Terms have FOUR — already open, stale, none
   * open, and a token that resolves to nothing — and only the server can tell them
   * apart. Collapsing those into one sentence would drop the operator's remedy: "this
   * restaurant already has different open terms" and "this restaurant has no open terms"
   * call for opposite next actions. The backend curates those four sentences for display
   * and deliberately strips the row ids out of them, which is what makes them safe to
   * pass through.
   */
  readonly conflict: (error: unknown) => string;
}

/** The service-configuration axes (Step 3E.2). One conflict, stated by the panel. */
const AXIS_COPY: Record<'timing' | 'collection', CommercialWriteCopy> = {
  timing: {
    recorded: 'Payment timing recorded.',
    unchanged: 'Payment timing was already set to that value. Nothing was changed.',
    conflict: () => 'Configuration changed since you loaded it.',
  },
  collection: {
    recorded: 'Collection mode recorded.',
    unchanged: 'Collection mode was already set to that value. Nothing was changed.',
    conflict: () => 'Configuration changed since you loaded it.',
  },
};

/**
 * The subscription-terms operations (Step 3E.3).
 *
 * NOT ONE WORD IMPLIES MONEY MOVED. Recorded, replaced and ended describe rows in a
 * terms table; there is no invoice model, no receivable and no collection path behind
 * any of them. Nothing here says activated, cancelled, subscribed, billed, charged,
 * paid, refunded or revoked, and "ended" is never dressed up as any of those.
 */
const TERMS_COPY: Record<'record' | 'replace' | 'end', CommercialWriteCopy> = {
  record: {
    recorded: 'Subscription terms recorded.',
    unchanged: 'These subscription terms were already recorded. Nothing was changed.',
    conflict: (error) =>
      extractErrorMessage(error, 'Subscription terms changed since they were loaded.'),
  },
  replace: {
    recorded: 'Subscription terms replaced.',
    unchanged: 'These are already the current subscription terms. Nothing was changed.',
    conflict: (error) =>
      extractErrorMessage(error, 'Subscription terms changed since they were loaded.'),
  },
  end: {
    recorded: 'Subscription terms ended.',
    unchanged: 'These subscription terms were already ended. Nothing was changed.',
    conflict: (error) =>
      extractErrorMessage(error, 'Subscription terms changed since they were loaded.'),
  },
};

function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)['status'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

@Component({
  selector: 'app-restaurant-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    StatusPillComponent,
    AdminButtonComponent,
    CommercialAxisEditorComponent,
    SubscriptionTermsEditorComponent,
    SubscriptionTermsEndComponent,
  ],
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
              <!-- WHEN the diner pays, relative to eating. A service-model fact.

                   THE ROW IS NOT REPAINTED WHILE A WRITE IS IN FLIGHT (§16: no
                   optimistic UI). It goes on showing the value the server last
                   confirmed, and changes only when a 200 hands back the canonical
                   projection — a write is real once its audit row commits, and a row
                   that moved early has told the operator something that may not be
                   true. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Payment timing</dt>
                <dd class="flex items-baseline justify-end gap-3 text-right">
                  <span [class]="definition" data-axis-value="payment_timing">{{
                    paymentTiming()
                  }}</span>
                  <app-admin-button
                    variant="ghost"
                    [disabled]="changeDisabled()"
                    (pressed)="openEditor('timing')"
                    >Change</app-admin-button
                  >
                </dd>
              </div>
              @if (paymentTimingSetAt(); as when) {
                <!-- WHEN THE DECISION WAS RECORDED — named precisely, because this is
                     not when the terms took effect and not when anything was agreed. -->
                <div class="text-right text-admin-meta text-ink-subtle">Set {{ when }}</div>
              }

              <!-- WHO initiates the payment. A custody fact, independent of the row
                   above — the two axes are separate decisions with separate lifetimes,
                   and each has its own control for exactly that reason. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Collection mode</dt>
                <dd class="flex items-baseline justify-end gap-3 text-right">
                  <span [class]="definition" data-axis-value="payment_collection_mode">{{
                    collectionMode()
                  }}</span>
                  <app-admin-button
                    variant="ghost"
                    [disabled]="changeDisabled()"
                    (pressed)="openEditor('collection')"
                    >Change</app-admin-button
                  >
                </dd>
              </div>
              @if (collectionModeSetAt(); as when) {
                <div class="text-right text-admin-meta text-ink-subtle">Set {{ when }}</div>
              }

              <!-- WHAT DINIFY HAS WRITTEN DOWN that this restaurant pays it. The price
                   and the recurrence themselves — never a status word.

                   THE CONTROLS FOLLOW THE STATE, AND NEVER ALL THREE AT ONCE (Step
                   3E.3). With no open terms the only thing an operator can do is
                   Record; with open terms the only things they can do are Replace and
                   End. Offering Record beside open terms would suggest a second
                   concurrent set is possible — the database's partial unique index says
                   it is not — and offering Replace or End with none open would be two
                   controls whose only outcome is a 409.

                   WITH NO commercial OBJECT AT ALL, none of them appears. Absence is not
                   "Not configured": the server did not answer, so this screen does not
                   know whether terms are open, and a control that guesses is a control
                   that acts on a guess. -->
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Subscription terms</dt>
                <dd class="flex items-baseline justify-end gap-3 text-right">
                  <span [class]="definition">
                    <span class="block" data-terms-value>{{ subscriptionTerms() }}</span>
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
                  </span>
                  @if (canRecordTerms()) {
                    <app-admin-button
                      variant="ghost"
                      [disabled]="changeDisabled()"
                      (pressed)="openTermsEditor('record')"
                      >Record terms</app-admin-button
                    >
                  }
                  @if (hasSubscriptionTerms()) {
                    <app-admin-button
                      variant="ghost"
                      [disabled]="changeDisabled()"
                      (pressed)="openTermsEditor('replace')"
                      >Replace terms</app-admin-button
                    >
                    <app-admin-button
                      variant="ghost"
                      [disabled]="changeDisabled()"
                      (pressed)="openTermsEditor('end')"
                      >End terms</app-admin-button
                    >
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

            <!-- ONE EDITOR AT A TIME (Step 3E.2), rendered below the rows it changes.

                 That is not only layout. Each successful axis write returns the WHOLE
                 canonical commercial object, so two writes in flight from this panel
                 could land out of order and the older snapshot would repaint the other
                 axis. One open editor and one in-flight request makes that race
                 unrepresentable rather than unlikely. It is not a substitute for server
                 concurrency — expected_current and the 409 handle other operators. -->
            @if (editing() === 'timing') {
              <app-commercial-axis-editor
                axisId="payment-timing"
                heading="Payment timing"
                [options]="timingOptions"
                [current]="timingValue()"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="saveTiming($event)"
                (cancelled)="closeEditor()"
              />
            }

            @if (editing() === 'collection') {
              <app-commercial-axis-editor
                axisId="payment-collection-mode"
                heading="Collection mode"
                [options]="collectionOptions"
                [current]="collectionValue()"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="saveCollection($event)"
                (cancelled)="closeEditor()"
              />
            }

            <!-- THE SAME ONE-EDITOR SLOT, now shared by FIVE commercial writes rather
                 than the two service-configuration ones. Terms writes return the whole
                 canonical object exactly as the axis writes do, so a terms write racing
                 an axis write would repaint the other with an older snapshot — which is
                 precisely the race the single slot makes unrepresentable. -->
            @if (editing() === 'record') {
              <app-subscription-terms-editor
                heading="Record subscription terms"
                submitLabel="Record terms"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="saveRecordTerms($event)"
                (cancelled)="closeEditor()"
              />
            }

            @if (editing() === 'replace') {
              <!-- PREFILLED FROM THE SNAPSHOT TAKEN WHEN THIS EDITOR OPENED, not from
                   the live store — the same discipline as the concurrency token beside
                   it. A form that re-filled itself from a background change would
                   overwrite what the operator had typed with facts they never saw. -->
              <app-subscription-terms-editor
                heading="Replace subscription terms"
                submitLabel="Replace terms"
                [prefill]="termsPrefill()"
                [refuseUnchanged]="true"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="saveReplaceTerms($event)"
                (cancelled)="closeEditor()"
              />
            }

            @if (editing() === 'end') {
              <app-subscription-terms-end
                [subject]="endSubject()"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="saveEndTerms($event)"
                (cancelled)="closeEditor()"
              />
            }

            @if (writeError(); as message) {
              @if (editing() === null) {
                <!-- A failure the editor is no longer open to carry — a conflict, or a
                     restaurant that disappeared. It stays on the panel until the next
                     deliberate edit. -->
                <p class="mt-3 max-w-prose text-admin-body text-admin-warning" data-commercial-panel-error>
                  {{ panelMessage() }}
                </p>
              }
            }

            @if (confirmation(); as message) {
              <!-- Restrained by design. A recorded configuration is not an achievement,
                   and §10 asks a completed state to recede — so this is one quiet line
                   that says exactly what happened, including when nothing did. -->
              <p [class]="note" data-commercial-confirmation>{{ message }}</p>
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

  /**
   * True only where the server ANSWERED and said no terms are open.
   *
   * `commercial === null` is not that answer — it is the absence of one — and offering
   * Record there would manufacture "there are none" out of a missing payload, the same
   * defect class as a dead backend presenting as "Invalid credentials." Guarded on
   * `current` rather than on `configured`, like every other reader in this slice: what
   * is displayed is what is checked.
   */
  protected readonly canRecordTerms = computed(
    () => this.commercial() !== null && this.terms() === null,
  );

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

  // --- service-configuration writes (Step 3E.2) -----------------------------------
  //
  // TWO AXES, TWO NAMED API CALLS, ONE SHARED OUTCOME PATH. `saveTiming` and
  // `saveCollection` differ in exactly the two places that matter — which endpoint they
  // call and which value type they assert — and share everything downstream, because
  // "what does a 409 mean" is not a per-axis question.
  //
  // NOTHING HERE TOUCHES ELEVATION. No CSRF read, no /auth/elevate/ call, no inspection
  // of the client's elevation clock, no preflight. The POST goes through the ordinary
  // HttpClient stack; when the server answers 403 for stale elevation the existing
  // interceptor opens ONE dialog and replays THE ORIGINAL REQUEST once, so the replayed
  // body carries the same value, the same expected_current and the same reason. A
  // component that rebuilt the request after elevation would defeat exactly that.

  private readonly api = inject(RESTAURANT_API);
  private readonly serviceStatus = inject(AdminServiceStatus);

  /**
   * Which commercial editor is open, or none. Never two — see the template comment.
   *
   * FIVE VALUES, ONE SLOT. The two service-configuration axes (Step 3E.2) and the three
   * subscription-terms operations (Step 3E.3) share it, because every one of them
   * returns the WHOLE canonical commercial object and any two in flight together could
   * land out of order.
   */
  protected readonly editing = signal<CommercialEditor | null>(null);

  /**
   * IN FLIGHT — owned by the route-scoped workspace, not by this component.
   *
   * The tabs are sibling routes, so this component is destroyed and rebuilt on every tab
   * switch while a write keeps running. A local flag reads false on the new instance and
   * would let a second write start against the same restaurant; the store's lifetime is
   * the restaurant's, which is what the one-at-a-time rule is actually about.
   */
  protected readonly pending = this.workspace.mutating;
  protected readonly writeError = signal<string | null>(null);
  protected readonly writeFieldErrors = signal<Record<string, readonly string[]>>({});
  protected readonly confirmation = signal<string | null>(null);

  /**
   * The panel-level failure message, with a progress clause while the replacement read
   * is genuinely in flight.
   *
   * The base sentence is true at every moment; the suffix is added only while it is.
   * The alternative — one sentence claiming the restaurant "has been reloaded" — is
   * false for the whole window this fix is about.
   */
  protected readonly panelMessage = computed(() => {
    const message = this.writeError();
    if (message === null) return null;
    return this.workspace.detailSuperseded() ? `${message} Reloading…` : message;
  });

  /**
   * THE CONCURRENCY TOKEN, CAPTURED WHEN THE EDITOR OPENED.
   *
   * A plain signal and deliberately NOT a computed. The operator is asserting "this is
   * the value I reviewed"; if this recomputed from the store it would silently track a
   * background change, and a Save that looked like an ordinary edit would be asserting
   * against a value the operator never saw. Captured once, held for the attempt, and
   * replaced only by a fresh deliberate edit.
   */
  private readonly expectedCurrent = signal<string | null>(null);

  /**
   * THE TERMS CONCURRENCY TOKEN, CAPTURED WHEN THE EDITOR OPENED.
   *
   * `subscription_terms.current.id` — a ROW IDENTITY, not a value, and that is the whole
   * difference from the axes. An axis asserts "the value was X"; a replacement or an end
   * asserts "the row I am superseding is THIS row". A UUID cannot be reconstructed from
   * what is on screen, so losing it is not recoverable by looking harder — it is
   * captured once and replaced only by a fresh deliberate edit.
   */
  private readonly expectedTermsId = signal<string | null>(null);

  /**
   * The four immutable commercial facts of the row being replaced, snapshotted at open.
   *
   * A snapshot rather than a projection of the store, for the same reason the token is:
   * the operator is restating the terms they reviewed, and a form that re-derived them
   * from a background change would silently move the baseline the unchanged-facts check
   * is measured against.
   */
  protected readonly termsPrefill = signal<SubscriptionTermsPrefill | null>(null);

  /** The terms being ended, as they read when the End form opened. */
  protected readonly endSubject = signal('');

  protected readonly timingValue = computed(() => this.commercial()?.payment_timing.value ?? null);
  protected readonly collectionValue = computed(
    () => this.commercial()?.payment_collection_mode.value ?? null,
  );

  /**
   * No axis may start a change while a write is in flight ANYWHERE IN THIS WORKSPACE —
   * including on a freshly rebuilt Overview after a tab round-trip — OR while what is on
   * screen is known to have been superseded.
   *
   * The second half is the post-conflict recovery invariant: after a 409 the operator
   * must SEE the freshly reloaded canonical state before being allowed to decide again.
   * Without it there is a window — the conflict is handled, the write slot is released,
   * but the replacement GET has not landed — in which the panel still renders the stale
   * projection with live controls, and reopening an editor captures the same stale token
   * a second time.
   */
  protected readonly changeDisabled = computed(
    () => this.workspace.mutating() || this.workspace.detailSuperseded(),
  );

  protected readonly timingOptions: readonly CommercialAxisOption[] = [
    {
      value: 'pay_first',
      label: 'Pay first',
      note: 'Settlement is expected before the kitchen fires the order.',
    },
    {
      value: 'pay_after',
      label: 'Pay after',
      note: 'The order can proceed before settlement, and the tab is settled afterwards.',
    },
  ];

  protected readonly collectionOptions: readonly CommercialAxisOption[] = [
    {
      value: 'offline',
      // NEVER "Cash only": that names one tender out of many and misreports a
      // restaurant running its own card machine or mobile-money till. A permanent,
      // first-class mode — not a fallback, not degraded, not pre-launch.
      label: 'Restaurant collects',
      note:
        'Dinify does not initiate the diner payment. The restaurant collects it itself, ' +
        'through cash, its own mobile-money till, its own card terminal or another ' +
        'external mechanism.',
    },
    {
      value: 'psp_online',
      label: 'Dinify via PSP',
      // INITIATES, never collects or holds. The restaurant stays merchant of record and
      // funds settle directly to it; Dinify takes no custody of diner money in either
      // mode.
      note:
        'Dinify is recorded as initiating the diner payment through a licensed provider ' +
        'on the restaurant’s behalf. The restaurant remains merchant of record and funds ' +
        'settle directly to it.',
      // Selectable, and deliberately so. The value is a legitimate commercial decision;
      // the safety mechanism is fail-closed readiness later, not a control that refuses
      // to record what an operator decided.
      warning:
        'This records the intended collection mode only. It connects no provider and ' +
        'creates no merchant account. Provider readiness is not available yet, so a ' +
        'restaurant configured this way cannot satisfy future go-live readiness until ' +
        'provider-authoritative readiness exists.',
    },
  ];

  /**
   * Open one editor, capturing the token the operator is looking at.
   *
   * Opening the other axis closes this one and discards its draft: only one local
   * service-configuration change may be in progress at a time.
   */
  protected openEditor(axis: 'timing' | 'collection'): void {
    // The same gate the button reads, enforced here too: a disabled button is a
    // presentation, and the token capture below is the thing that actually matters.
    if (this.changeDisabled()) return;
    this.clearOutcome();
    this.clearTokens();
    this.expectedCurrent.set(axis === 'timing' ? this.timingValue() : this.collectionValue());
    this.editing.set(axis);
  }

  /**
   * Open one terms editor, capturing what the operator is looking at.
   *
   * Record captures NOTHING — the operation means "record terms only if none are open",
   * and the backend enforces that under the restaurant lock. There is deliberately no
   * `expected_terms_id` on that request: a token nothing consults is a field the caller
   * has to supply and no layer checks.
   *
   * Replace and End capture the OPEN ROW'S ID, and refuse to open without one. A missing
   * id means the projection does not describe an open row, and an editor that opened
   * anyway would collect a reason and a boundary only to send an assertion about nothing.
   */
  protected openTermsEditor(kind: 'record' | 'replace' | 'end'): void {
    if (this.changeDisabled()) return;

    if (kind === 'record') {
      if (!this.canRecordTerms()) return;
      this.clearOutcome();
      this.clearTokens();
      this.editing.set('record');
      return;
    }

    const terms = this.terms();
    if (terms === null) return;

    this.clearOutcome();
    this.clearTokens();
    this.expectedTermsId.set(terms.id);

    if (kind === 'replace') {
      this.termsPrefill.set({
        // The stored decimal STRING, handed to the form untouched. Parsing it to
        // prefill a field and re-serialising on save would put a float in the middle of
        // a round trip the backend keeps exact.
        recurring_amount: terms.recurring_amount,
        currency: terms.currency,
        billing_interval_unit: terms.billing_interval.unit,
        billing_interval_count: terms.billing_interval.count,
      });
      this.editing.set('replace');
      return;
    }

    this.endSubject.set(
      `${subscriptionAmountLabel(terms)} · ${billingIntervalLabel(terms.billing_interval)}`,
    );
    this.editing.set('end');
  }

  protected closeEditor(): void {
    if (this.workspace.mutating()) return;
    this.editing.set(null);
    this.clearTokens();
    this.clearOutcome();
  }

  /** Every captured assertion and snapshot. Cleared together, so none can outlive its editor. */
  private clearTokens(): void {
    this.expectedCurrent.set(null);
    this.expectedTermsId.set(null);
    this.termsPrefill.set(null);
    this.endSubject.set('');
  }

  protected saveTiming(submission: CommercialAxisSubmission): void {
    const id = this.restaurant()?.id;
    if (id === undefined) return;
    // The slot is claimed BEFORE anything is sent, and the claim is the guard — a
    // separate `pending()` check would be a second source of truth that could disagree
    // with it.
    if (!this.beginWrite()) return;

    this.api
      .setPaymentTiming(id, {
        value: submission.value as PaymentTiming,
        // EXPLICIT NULL, never undefined — `JSON.stringify` drops an undefined property
        // and the server treats an omitted assertion as a 400, not as "was unconfigured".
        expected_current: this.expectedCurrent() as PaymentTiming | null,
        reason: submission.reason,
      })
      .subscribe({
        next: (result) => this.onWritten(result.changed, result.commercial, AXIS_COPY.timing),
        error: (error: unknown) => this.onWriteFailed(error, AXIS_COPY.timing),
      });
  }

  protected saveCollection(submission: CommercialAxisSubmission): void {
    const id = this.restaurant()?.id;
    if (id === undefined) return;
    // The slot is claimed BEFORE anything is sent, and the claim is the guard — a
    // separate `pending()` check would be a second source of truth that could disagree
    // with it.
    if (!this.beginWrite()) return;

    this.api
      .setPaymentCollectionMode(id, {
        value: submission.value as PaymentCollectionMode,
        expected_current: this.expectedCurrent() as PaymentCollectionMode | null,
        reason: submission.reason,
      })
      .subscribe({
        next: (result) => this.onWritten(result.changed, result.commercial, AXIS_COPY.collection),
        error: (error: unknown) => this.onWriteFailed(error, AXIS_COPY.collection),
      });
  }

  /**
   * THE THREE SUBSCRIPTION-TERMS WRITES (Step 3E.3).
   *
   * Three named operations, never one parameterised by an action. Recording a first set
   * of terms, superseding the open ones and closing them are different decisions with
   * different preconditions, different concurrency tokens and different histories left
   * behind — the backend refused a `subscription-terms/<action>/` route for exactly that
   * reason, and a client that collapsed them would make "what did this operator do?" a
   * question about an argument.
   *
   * They share `onWritten` / `onWriteFailed` with the axes, because "what does a 409
   * mean" and "what does an indeterminate outcome mean" are not per-operation questions.
   */
  protected saveRecordTerms(submission: SubscriptionTermsSubmission): void {
    const id = this.restaurant()?.id;
    if (id === undefined) return;
    if (!this.beginWrite()) return;

    this.api
      // NO `expected_terms_id`. The operation asserts "none are open", which the server
      // checks under the restaurant lock; a token here would be checked by nothing.
      .recordSubscriptionTerms(id, { ...submission })
      .subscribe({
        next: (result) => this.onWritten(result.changed, result.commercial, TERMS_COPY.record),
        error: (error: unknown) => this.onWriteFailed(error, TERMS_COPY.record),
      });
  }

  protected saveReplaceTerms(submission: SubscriptionTermsSubmission): void {
    const id = this.restaurant()?.id;
    const expected = this.expectedTermsId();
    // NEVER a fresh read of the store. If the token is gone the request is not sent:
    // "supersede whatever happens to be open" is the stale-screen overwrite the token
    // exists to prevent, and the server has no way to tell it from a considered one.
    if (id === undefined || expected === null) return;
    if (!this.beginWrite()) return;

    this.api
      .replaceSubscriptionTerms(id, { expected_terms_id: expected, ...submission })
      .subscribe({
        next: (result) => this.onWritten(result.changed, result.commercial, TERMS_COPY.replace),
        error: (error: unknown) => this.onWriteFailed(error, TERMS_COPY.replace),
      });
  }

  protected saveEndTerms(submission: SubscriptionTermsEndSubmission): void {
    const id = this.restaurant()?.id;
    const expected = this.expectedTermsId();
    if (id === undefined || expected === null) return;
    if (!this.beginWrite()) return;

    this.api
      .endSubscriptionTerms(id, {
        expected_terms_id: expected,
        ended_at: submission.ended_at,
        reason: submission.reason,
      })
      .subscribe({
        next: (result) => this.onWritten(result.changed, result.commercial, TERMS_COPY.end),
        error: (error: unknown) => this.onWriteFailed(error, TERMS_COPY.end),
      });
  }

  /** Claim the workspace's single write slot. False means: send nothing. */
  private beginWrite(): boolean {
    if (!this.workspace.beginMutation()) return false;
    this.writeError.set(null);
    this.writeFieldErrors.set({});
    this.confirmation.set(null);
    return true;
  }

  private clearOutcome(): void {
    this.writeError.set(null);
    this.writeFieldErrors.set({});
    this.confirmation.set(null);
  }

  /**
   * A 200. Adopt the canonical projection the server returned and say what happened.
   *
   * `changed: false` IS A SUCCESS, not a failure and not a conflict — the server answers
   * a same-state request that way so a lost response followed by an exact retry does not
   * become a false conflict or re-stamp attribution. The canonical state is adopted
   * either way; only the sentence differs, and a no-op must never be described as a new
   * decision.
   */
  private onWritten(
    changed: boolean,
    commercial: CommercialSummary,
    copy: CommercialWriteCopy,
  ): void {
    this.workspace.adoptCommercial(commercial);
    this.workspace.endMutation();
    this.editing.set(null);
    this.clearTokens();
    this.writeError.set(null);
    this.writeFieldErrors.set({});
    this.confirmation.set(changed ? copy.recorded : copy.unchanged);
    // The server answered, so the control plane is reachable. Mock mode runs no
    // interceptor, so without this a mocked outage would never clear.
    this.serviceStatus.markReachable();
  }

  /**
   * Every failure that can reach a service-configuration write, told apart.
   *
   * The order matters: the two elevation outcomes are client-side objects with no HTTP
   * status, and a conflict is a well-formed answer rather than a defect.
   */
  private onWriteFailed(error: unknown, copy: CommercialWriteCopy): void {
    this.workspace.endMutation();

    // Re-authentication dismissed. NOTHING was sent, so the draft and the reason are
    // kept and the editor stays open — wiping an operator's typed reason because they
    // cancelled a prompt would make them retype it to do the thing they already decided.
    if (error instanceof ElevationCancelledError) {
      this.writeError.set('Re-authentication was cancelled. Nothing was changed.');
      return;
    }

    // Re-authentication could not complete — the service did not answer, or the session
    // ended underneath it. Nobody chose this, so it is not relabelled a validation
    // failure; the global auth and outage state stays authoritative for the rest.
    if (error instanceof ElevationAbandonedError) {
      this.writeError.set(
        'Re-authentication could not be completed, so nothing was changed. Try again once the admin service is reachable.',
      );
      return;
    }

    const status = readStatus(error);

    // THE CONCURRENCY OUTCOME. Another write moved this axis after this screen took its
    // token. Not validation, not an outage, not a defect — and emphatically NOT retried
    // automatically: replaying with a fresh token would overwrite whatever the other
    // operator just decided, which is the exact thing expected_current exists to stop.
    if (status === 409) {
      this.serviceStatus.markReachable();
      this.discardStaleEditor();
      // NOT "has been reloaded" — the read has not happened yet at this point, and this
      // panel spends the rest of its existence refusing to claim things prematurely.
      // The transient progress half is appended by `panelMessage` while it is true.
      this.writeError.set(
        `${copy.conflict(error)} Review the current value before trying again.`,
      );
      // Marks the projection superseded for the duration, so no second decision can be
      // taken against it. The workspace owns what happens next, including a failed read.
      this.workspace.reloadSuperseded();
      return;
    }

    // The restaurant is gone — deleted after this screen loaded it. Presenting an
    // editable stale tenant would invite a write against something that no longer
    // exists, so the editor is discarded and the established not-found path takes the
    // screen.
    if (status === 404) {
      this.serviceStatus.markReachable();
      this.discardStaleEditor();
      // Superseded for the same reason, and it matters for the same window: until the
      // re-read lands and the workspace takes the screen with its not-found state, the
      // panel is still rendering a tenant that no longer exists.
      this.workspace.reloadSuperseded();
      return;
    }

    // Validation. Keep the form and the draft open so the operator can fix it, and put
    // the server's own words beside the field it named.
    if (status === 400) {
      this.serviceStatus.markReachable();
      this.writeFieldErrors.set(extractFieldErrors(error));
      this.writeError.set(extractErrorMessage(error, 'The request could not be applied.'));
      return;
    }

    // No usable answer: status 0, any 5xx. The outcome is INDETERMINATE — the write may
    // or may not have committed — so nothing claims it failed to commit, the draft is
    // preserved, and the operator can deliberately retry the same request. An exact
    // retry of a write that did land answers `changed: false`, which is precisely why
    // the backend supports same-state retry.
    if (classifyTransportFailure(error) === 'unavailable') {
      this.serviceStatus.reportUnavailable(extractRequestId(error));
      this.writeError.set(
        'The admin service did not answer, so it is not known whether this change was recorded. Check the current value before trying again.',
      );
      return;
    }

    // A 401 is owned by the global classifier, which clears the session and routes to
    // /login; anything else unexpected reaches the defect machinery through the same
    // interceptor. Either way the pending state is already cleared above, and the
    // operator is told something rather than left looking at a form that went quiet.
    this.serviceStatus.markReachable();
    this.writeError.set(extractErrorMessage(error, 'The change could not be applied.'));
  }

  /** A conflict or a vanished restaurant invalidates the token this editor captured. */
  private discardStaleEditor(): void {
    this.editing.set(null);
    this.clearTokens();
    this.writeFieldErrors.set({});
    this.confirmation.set(null);
  }

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
        Where Dinify is recorded as initiating the diner payment through a provider,
        provider-authoritative merchant readiness is REQUIRED — and with no integration built,
        that requirement is required but UNAVAILABLE: nothing can satisfy it, so it blocks rather
        than being waived. There is still no provider, no merchant identity and no readiness
        verdict for this portal to report; what the engine will report is that the question
        cannot yet be answered.
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
