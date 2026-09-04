import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';

import { AdminServiceStatus } from '../core/api/service-status';
import { extractErrorMessage, extractFieldErrors } from '../core/api/error-message';
import { classifyTransportFailure, extractRequestId } from '../core/api/transport-failure';
import { ElevationAbandonedError, ElevationCancelledError } from '../core/auth/elevation.service';
import { formatEat } from '../core/formatting/time';
import {
  NO_VALUE,
  ONBOARDING_UNTRACKED_NOTE,
  ownerControlEvidenceLabel,
  ownerControlIsNotable,
  ownerControlLabel,
  ownerControlNote,
  ownerInvitationIsNotable,
  ownerInvitationLabel,
  ownerInvitationNote,
} from '../core/restaurants/restaurant.labels';
import { RESTAURANT_API } from '../core/restaurants/restaurant.api';
import {
  OwnerInvitationCancelResult,
  OwnerInvitationReissueResult,
  RestaurantDetail,
  UNRESOLVED_OWNER_INVITATION_STATUSES,
} from '../core/restaurants/restaurant.model';
import {
  OwnerInvitationWriteAction,
  RestaurantWorkspaceStore,
} from '../core/restaurants/restaurant-workspace.store';
import { AdminButtonComponent } from '../ui/button.component';
import { OwnerClaimCodeComponent } from './owner-claim-code.component';
import {
  OwnerInvitationActionComponent,
  OwnerInvitationActionSubmission,
} from './owner-invitation-action.component';
import {
  DEFINITION,
  DEFINITION_NOTABLE,
  invitationWindowLine,
  NOTE,
  NOTE_NOTABLE,
  PANEL,
  readStatus,
  TERM,
} from './restaurant-tabs.pages';

/**
 * THE READINESS TAB — in its own file, and LAZY (Step 2G).
 *
 * Split out of `restaurant-tabs.pages.ts` for one reason: the owner-claim panel, the
 * claim-code panel and the action form it renders pushed the eager initial bundle past
 * the 500 kB warning budget, and a tab an operator opens for one restaurant at a time
 * has no business in the bundle every operator downloads to look at the directory.
 * `app.routes.ts` loads it with `loadComponent` on the `readiness` child route; it is
 * still a CHILD of the persistent workspace header, and it still reads the same
 * route-scoped `RestaurantWorkspaceStore` the other tabs do — laziness changes when
 * the code arrives, not where the state lives. The shared panel styles, the
 * `invitationWindowLine` helper (Overview renders it too) and `readStatus` are
 * imported from the tabs file rather than copied.
 */
/**
 * ══ THE OWNER-INVITATION CONTROLS (Step 2G, over backend Step 2E) ═════════════════
 *
 * Which of the two credential actions the SERVER would accept for a projection —
 * derived from `onboarding_invitations`'s own refusal rules, read from source, so the
 * panel offers only what can succeed and names why when it cannot. The server remains
 * authoritative: a race that changes the answer between this read and the POST is a
 * 409, handled below.
 *
 *   REISSUE is legitimate from a pending, expired, verification-locked, cancelled or
 *   superseded head, and from one consumed by a PREVIOUS owner. It is refused when the
 *   CURRENT owner's control is already established (`owner_control_already_established`
 *   — read off the owner-control axis, never off the invitation's status), when the
 *   owner relationship has drifted (the three owner-consistency codes: reissue mints
 *   authority and will not do so while "who owns this?" has two answers), and when
 *   there is no active owner account to invite.
 *
 *   CANCEL is legitimate ONLY from an unresolved head — pending, expired, verification
 *   locked. A cancelled head is an exact retry the server answers `changed: false`; a
 *   consumed or superseded one is `owner_invitation_already_resolved`. Cancellation
 *   deliberately requires NO owner consistency: revoking a credential must stay
 *   possible exactly when a tenant's state is messy.
 *
 *   NEITHER applies to a legacy-adopted restaurant (`not_applicable`), to an untracked
 *   one, or to a head of `not_issued` — there is no credential to act on.
 *
 * THE TWO AXES STAY SEPARATE. `invitation.status` says what is outstanding;
 * `owner_control.status` says whether the CURRENT owner has claimed. `pending` beside
 * `invitation_redeemed` is a real state (a live credential outstanding for an owner who
 * already claimed) and it offers CANCEL and not REISSUE; `consumed` beside
 * `not_established` is another (a previous owner claimed) and it offers REISSUE.
 */
export type InvitationAction = OwnerInvitationWriteAction;

export interface InvitationControls {
  readonly reissue: boolean;
  readonly cancel: boolean;
  /** Why reissue is unavailable although a head exists, in operator English. */
  readonly reissueBlocker: string | null;
}

const NO_INVITATION_CONTROLS: InvitationControls = {
  reissue: false,
  cancel: false,
  reissueBlocker: null,
};

export function invitationControlsFor(detail: RestaurantDetail | null): InvitationControls {
  if (detail === null) return NO_INVITATION_CONTROLS;
  const onboarding = detail.onboarding;
  if (!onboarding.tracked || onboarding.source !== 'admin_created') {
    return NO_INVITATION_CONTROLS;
  }
  const head = onboarding.invitation;
  if (head.id === null || head.status === 'not_issued') return NO_INVITATION_CONTROLS;

  const cancel = UNRESOLVED_OWNER_INVITATION_STATUSES.includes(head.status);

  let reissueBlocker: string | null = null;
  if (onboarding.owner_control.status === 'invitation_redeemed') {
    reissueBlocker =
      'The current owner has already claimed this restaurant, so no new claim code is needed.';
  } else if (onboarding.owner_relationship.status !== 'consistent') {
    reissueBlocker =
      'A new claim code cannot be issued while the owner of record and the owner authority ' +
      'disagree. Resolve the owner relationship first.';
  } else if (detail.owner === null) {
    reissueBlocker = 'There is no owner account to issue a claim code to.';
  } else if (!detail.owner.is_active) {
    reissueBlocker = 'The owner account is deactivated, so no claim code can be issued to it.';
  }

  return { reissue: reissueBlocker === null, cancel, reissueBlocker };
}

/** What each invitation action DOES, stated exactly and claiming nothing beyond it. */
const INVITATION_COPY: Record<
  InvitationAction,
  { readonly heading: string; readonly consequence: string; readonly submit: string }
> = {
  reissue: {
    heading: 'Reissue claim code',
    consequence:
      'Reissuing rotates the claim code: any code already handed to the owner stops working ' +
      'the moment the new one is issued, and the new one is shown here once, to you. ' +
      'Nothing is delivered to the owner.',
    submit: 'Reissue claim code',
  },
  cancel: {
    heading: 'Cancel invitation',
    consequence:
      'Cancelling withdraws the claim code: it stops working and no replacement is issued. ' +
      'The owner account is not changed and keeps whatever access it already has elsewhere; ' +
      'the invitation history is retained. Reissue later if the owner should still claim.',
    submit: 'Cancel invitation',
  },
};

@Component({
  selector: 'app-restaurant-readiness-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminButtonComponent, OwnerClaimCodeComponent, OwnerInvitationActionComponent],
  template: `
    <div class="space-y-4">
      <!-- A. OWNER CLAIM (Step 2G) ───────────────────────────────────────────────
           The operator side of the ownership chain. Spec §14 puts the invitation
           state machine on this tab, beside the go-live blocker it satisfies. -->
      <section [class]="panel" aria-labelledby="owner-claim-heading">
        <h2 id="owner-claim-heading" class="text-admin-section text-ink">Owner claim</h2>
        <p class="mt-1 max-w-prose text-admin-body text-ink-muted">
          Only the owner can establish owner control, by redeeming a claim code in the
          restaurant portal. This panel issues and withdraws claim codes; it delivers nothing
          and establishes nothing.
        </p>

        @if (restaurant()) {
          @if (isUntracked()) {
            <p class="mt-3 max-w-prose text-admin-body text-ink-muted">{{ untrackedNote }}</p>
          } @else {
            <dl class="mt-3 space-y-1.5">
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Owner control</dt>
                <dd
                  [class]="ownerControlNotable() ? definitionNotable : definition"
                  data-claim-owner-control
                >
                  {{ ownerControl() }}
                </dd>
              </div>
              <div class="flex items-baseline justify-between gap-4">
                <dt [class]="term">Invitation</dt>
                <dd
                  [class]="invitationNotable() ? definitionNotable : definition"
                  data-claim-invitation
                >
                  {{ invitation() }}
                </dd>
              </div>
            </dl>

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
            @if (invitationWindow(); as line) {
              <p [class]="note" data-claim-window>{{ line }}</p>
            }
            @if (invitationNote(); as copy) {
              <p [class]="invitationNotable() ? noteNotable : note" data-claim-invitation-note>
                {{ copy }}
              </p>
            }
            @if (legacy()) {
              <!-- NOT "not issued". A pre-existing restaurant never entered a claim
                   flow; owner control for it is attested administratively, and this
                   portal does not perform that yet. -->
              <p [class]="note" data-claim-legacy-note>
                This restaurant existed before the Admin onboarding record was introduced, so
                no claim code applies to it.
              </p>
            }
            @if (controls().reissueBlocker; as blocker) {
              <p [class]="note" data-claim-reissue-blocker>{{ blocker }}</p>
            }

            <!-- THE CONTROLS FOLLOW THE STATE, per the matrix above. Both are shut while
                 an invitation write is in flight anywhere in this workspace — including
                 on a freshly rebuilt tab — and while the projection is known stale. -->
            @if (controls().reissue || controls().cancel) {
              <div class="mt-4 flex flex-wrap items-center gap-2" data-claim-actions>
                @if (controls().reissue) {
                  <app-admin-button
                    variant="secondary"
                    [disabled]="actionsDisabled()"
                    (pressed)="openAction('reissue')"
                    >Reissue claim code</app-admin-button
                  >
                }
                @if (controls().cancel) {
                  <app-admin-button
                    variant="ghost"
                    [disabled]="actionsDisabled()"
                    (pressed)="openAction('cancel')"
                    >Cancel invitation</app-admin-button
                  >
                }
              </div>
            }

            @if (editing(); as action) {
              <app-owner-invitation-action
                [heading]="copyFor(action).heading"
                [subject]="subject()"
                [consequence]="copyFor(action).consequence"
                [submitLabel]="copyFor(action).submit"
                [pending]="pending()"
                [errorMessage]="writeError()"
                [fieldErrors]="writeFieldErrors()"
                (save)="save(action, $event)"
                (cancelled)="closeAction()"
              />
            }

            <!-- THE ONE-TIME CREDENTIAL, held in this tab's own state and nowhere else.
                 It stays until Done, through the canonical adoption underneath it, so
                 the operator can copy it while the invitation row already reports the
                 new pending credential. -->
            @if (claimToken(); as token) {
              <app-owner-claim-code
                heading="Claim code reissued"
                intro="Any earlier claim code no longer works."
                [claimToken]="token"
                [issuedAt]="issued()?.issued_at ?? null"
                [expiresAt]="issued()?.expires_at ?? null"
              >
                <app-admin-button variant="primary" (pressed)="dismissClaimCode()" data-claim-done
                  >Done</app-admin-button
                >
              </app-owner-claim-code>
            }

            @if (writeError(); as message) {
              @if (editing() === null) {
                <p
                  class="mt-3 max-w-prose text-admin-body text-admin-warning"
                  data-claim-panel-error
                >
                  {{ panelMessage() }}
                </p>
              }
            }

            @if (indeterminateResolution(); as message) {
              <p class="mt-2 max-w-prose text-admin-body text-admin-warning" data-claim-indeterminate>
                {{ message }}
              </p>
            }

            @if (orphanedWrite()) {
              <!-- A reissue from a PREVIOUS instance of this tab landed after that tab
                   was gone. The projection above is current; the credential it produced
                   was never shown and never will be. -->
              <p class="mt-2 max-w-prose text-admin-body text-admin-warning" data-claim-orphaned>
                The claim code was reissued while this tab was closed, so no claim code from it
                could be shown here, and it cannot be retrieved. If the owner still needs a code,
                reissue again.
              </p>
            }

            @if (confirmation(); as message) {
              <p [class]="note" data-claim-confirmation>{{ message }}</p>
            }
          }
        } @else if (workspace.loading()) {
          <p class="mt-3 text-admin-body text-ink-muted" aria-busy="true">Loading…</p>
        }
      </section>

      <!-- B. THE READINESS ENGINE — still not built. -->
      <section [class]="panel" aria-labelledby="readiness-heading">
        <h2 id="readiness-heading" class="text-admin-section text-ink">Readiness</h2>
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
          The owner claim panel above is the operator side of the ownership requirement: it
          issues and withdraws claim codes. Whether the owner has claimed is reported from the
          canonical record and is never asserted here; go-live approval by the owner is a separate,
          still-undesigned step.
        </p>
        <p class="mt-3 text-admin-meta text-ink-subtle">Spec §10 — arrives with step 3.</p>
      </section>
    </div>
  `,
})
export class RestaurantReadinessTab {
  /** The SAME store instance the header and Overview use — one read for the workspace. */
  protected readonly workspace = inject(RestaurantWorkspaceStore);
  private readonly api = inject(RESTAURANT_API);
  private readonly serviceStatus = inject(AdminServiceStatus);

  protected readonly restaurant = this.workspace.detail;

  protected readonly panel = PANEL;
  protected readonly term = TERM;
  protected readonly definition = DEFINITION;
  protected readonly definitionNotable = DEFINITION_NOTABLE;
  protected readonly note = NOTE;
  protected readonly noteNotable = NOTE_NOTABLE;
  protected readonly untrackedNote = ONBOARDING_UNTRACKED_NOTE;

  // --- the projection, read exactly as Overview reads it -------------------------

  private readonly onboarding = computed(() => this.restaurant()?.onboarding ?? null);

  protected readonly isUntracked = computed(() => this.onboarding()?.tracked === false);
  protected readonly legacy = computed(() => this.onboarding()?.source === 'legacy_adopted');

  protected readonly ownerControl = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlLabel(summary.owner_control.status) : NO_VALUE;
  });
  protected readonly ownerControlNotable = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlIsNotable(summary.owner_control.status) : false;
  });
  protected readonly controlNote = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlNote(summary.owner_control.status) : null;
  });
  protected readonly evidenceLabel = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerControlEvidenceLabel(summary.owner_control.evidence) : null;
  });
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
  protected readonly invitationNote = computed(() => {
    const summary = this.onboarding();
    return summary ? ownerInvitationNote(summary.invitation.status) : null;
  });
  protected readonly invitationWindow = computed(() =>
    invitationWindowLine(this.onboarding()?.invitation ?? null),
  );

  /** Which actions the server would accept for THIS projection. See `invitationControlsFor`. */
  protected readonly controls = computed(() => invitationControlsFor(this.restaurant()));

  /**
   * A reissue from a PREVIOUS instance of this tab landed after that instance was gone,
   * and the head on screen is the credential it minted.
   *
   * The tabs are sibling routes, so an operator who clicks Reissue and then Overview has
   * this tab destroyed while the request runs. The request is deliberately not torn down
   * with it (cancelling the subscription would not un-send it), and when it lands the
   * dead instance adopts the projection into the shared store — which this instance
   * renders — and must drop the raw code, because the store is the right place for the
   * projection and the wrong place for a credential. What the dead instance records
   * instead, on the store, is the NON-SECRET fact: the id of the invitation whose code
   * went unseen (`markCodeUnshown`). This tab renders the note while that id is still the
   * unresolved head, rather than leaving a fresh "Pending" row with no explanation of
   * where its code went; the remedy is the usual one.
   *
   * WHY A STORE RECORD AND NOT A CONSTRUCTION-TIME WATCH. The first version of this tab
   * noticed the case only when the write was still in flight as it was built, and review
   * found the half it missed: a reissue that COMPLETED while the operator was on Overview
   * left the slot released, so the rebuilt tab saw nothing to watch and said nothing. The
   * fact has to outlive the tab that produced it, so it lives where the projection does.
   *
   * A cancellation landing the same way raises nothing: its answer carries nothing that
   * could be lost. And the note disappears on its own once the head moves on — a fresh
   * reissue (whose code IS shown) or a cancellation resolves it.
   */
  protected readonly orphanedWrite = computed(() => {
    const unshown = this.workspace.unshownCodeInvitationId();
    const head = this.onboarding()?.invitation;
    return (
      unshown !== null &&
      head?.id === unshown &&
      UNRESOLVED_OWNER_INVITATION_STATUSES.includes(head.status)
    );
  });

  /**
   * Whether this instance has been destroyed — read by the write callbacks, which
   * deliberately outlive it. A callback on a dead instance still owns the workspace-level
   * bookkeeping (the slot, the projection, the unshown-code record); what it must NOT do
   * is put the credential on a signal nobody will render.
   */
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
    });
  }

  // --- the writes ----------------------------------------------------------------
  //
  // TWO NAMED API CALLS, ONE SHARED OUTCOME PATH. `save('reissue', …)` and
  // `save('cancel', …)` differ in the endpoint they call and in what a success carries
  // (a credential, or none), and share everything downstream: "what does a 409 mean"
  // and "what does an indeterminate outcome mean" are not per-action questions.
  //
  // NOTHING HERE TOUCHES ELEVATION. The POST goes through the ordinary HttpClient
  // stack; a 403 for stale elevation opens ONE dialog and replays THE ORIGINAL request
  // once, so the replayed body carries the same `expected_invitation_id` and the same
  // reason. A component that rebuilt the request after elevation would defeat that.

  /** Which action's form is open, or none. One at a time. */
  protected readonly editing = signal<InvitationAction | null>(null);

  /**
   * IN FLIGHT — owned by the route-scoped workspace, not by this tab, because the tabs
   * are sibling routes and this one is destroyed and rebuilt on every tab switch while
   * the request keeps running. See `RestaurantWorkspaceStore.invitationMutating`.
   */
  protected readonly pending = this.workspace.invitationMutating;

  /**
   * No action may start while an invitation write is in flight ANYWHERE IN THIS
   * WORKSPACE — including on a freshly rebuilt tab — or while what is on screen is
   * known to have been superseded. The second half is the post-conflict recovery
   * invariant: after a 409 the operator must SEE the freshly reloaded canonical state
   * before being allowed to decide again, or the next action would capture the same
   * stale id.
   */
  protected readonly actionsDisabled = computed(
    () => this.workspace.invitationMutating() || this.workspace.detailSuperseded(),
  );

  /**
   * THE CONCURRENCY TOKEN, CAPTURED WHEN THE ACTION OPENED.
   *
   * A plain signal and deliberately NOT a computed: the operator is asserting "this is
   * the invitation I reviewed", and a computed would track a background reload and turn
   * an ordinary-looking Confirm into an assertion about an invitation nobody looked at.
   * Captured once, held for the attempt, and replaced only by a fresh deliberate action.
   */
  private readonly expectedInvitationId = signal<string | null>(null);

  /** The invitation being acted on, as it read when the form opened. */
  protected readonly subject = signal('');

  protected readonly writeError = signal<string | null>(null);
  protected readonly writeFieldErrors = signal<Record<string, readonly string[]>>({});
  protected readonly confirmation = signal<string | null>(null);

  /**
   * THE RAW CREDENTIAL FROM A REISSUE, and the metadata shown beside it.
   *
   * Transient state of THIS TAB: never the store (which outlives every tab and is the
   * wrong place for a bearer credential), never storage, never a URL. A tab switch
   * while it is on screen loses it, and the panel says so; the recovery is to reissue
   * again.
   */
  protected readonly claimToken = signal<string | null>(null);
  protected readonly issued = signal<{ issued_at: string; expires_at: string } | null>(null);

  /** The panel-level failure sentence, with a progress clause only while the re-read is in flight. */
  protected readonly panelMessage = computed(() => {
    const message = this.writeError();
    if (message === null) return null;
    return this.workspace.detailSuperseded() ? `${message} Reloading…` : message;
  });

  /**
   * WHAT THE RE-READ SAYS about an indeterminate write — stated only once it has
   * settled, and derived from the projection rather than guessed.
   *
   * A reissue that committed moved the head to a NEW invitation, so a changed id means
   * a credential exists that was never shown here; the only remedy is to reissue again,
   * which supersedes it. An unchanged id means nothing was minted. A cancellation is
   * read the same way, off the status of the invitation that was named.
   *
   * The write it describes is recorded on the WORKSPACE (`indeterminateInvitationWrite`),
   * so the verdict is still given by a tab rebuilt after the answer failed to arrive —
   * the unseen-credential case is exactly the one an operator is likeliest to have
   * walked away from.
   */
  protected readonly indeterminateResolution = computed(() => {
    const pending = this.workspace.indeterminateInvitationWrite();
    if (pending === null) return null;
    if (this.workspace.detailSuperseded()) return null;
    const head = this.onboarding()?.invitation;
    if (!head) return null;

    if (pending.action === 'reissue') {
      return head.id !== pending.expectedId
        ? 'A newer claim code is now on record, and it was never shown here. Reissue again to ' +
            'replace it with one you can copy.'
        : 'The invitation on record is unchanged, so no new claim code was issued.';
    }
    if (head.id !== pending.expectedId) {
      return 'The invitation on record has changed. Review it before deciding again.';
    }
    return head.status === 'cancelled'
      ? 'The invitation on record is now cancelled.'
      : 'The invitation on record was not cancelled.';
  });

  protected copyFor(action: InvitationAction) {
    return INVITATION_COPY[action];
  }

  /**
   * Open one action, capturing the id the operator is looking at.
   *
   * The same gate the buttons read, enforced here too: a disabled button is a
   * presentation, and the token capture below is the thing that actually matters. The
   * matrix is re-checked as well, so a click that outran a projection change cannot
   * open an action the state no longer offers.
   */
  protected openAction(action: InvitationAction): void {
    if (this.actionsDisabled()) return;
    const controls = this.controls();
    if (action === 'reissue' && !controls.reissue) return;
    if (action === 'cancel' && !controls.cancel) return;
    const head = this.onboarding()?.invitation;
    if (!head?.id) return;

    this.clearOutcome();
    this.workspace.clearIndeterminateInvitationWrite();
    this.expectedInvitationId.set(head.id);
    this.subject.set(
      `${ownerInvitationLabel(head.status)} · issued ${formatEat(head.issued_at)}`,
    );
    this.editing.set(action);
  }

  protected closeAction(): void {
    if (this.workspace.invitationMutating()) return;
    this.editing.set(null);
    this.expectedInvitationId.set(null);
    this.subject.set('');
    this.clearOutcome();
  }

  /** The operator has copied the code, or chosen not to. It is gone from this screen. */
  protected dismissClaimCode(): void {
    this.claimToken.set(null);
    this.issued.set(null);
  }

  protected save(action: InvitationAction, submission: OwnerInvitationActionSubmission): void {
    const id = this.restaurant()?.id;
    const expected = this.expectedInvitationId();
    // NEVER a fresh read of the store. If the captured id is gone the request is not
    // sent: "act on whatever is current" is the stale-screen overwrite the token exists
    // to prevent, and the server has no way to tell it from a considered one.
    if (id === undefined || expected === null) return;
    // The slot is claimed BEFORE anything is sent, and the claim is the guard.
    if (!this.workspace.beginInvitationMutation()) return;
    this.clearOutcome();

    const request = { expected_invitation_id: expected, reason: submission.reason };
    if (action === 'reissue') {
      this.api.reissueOwnerInvitation(id, request).subscribe({
        next: (result) => this.onReissued(result),
        error: (error: unknown) => this.onWriteFailed(error, action, expected),
      });
      return;
    }
    this.api.cancelOwnerInvitation(id, request).subscribe({
      next: (result) => this.onCancelled(result),
      error: (error: unknown) => this.onWriteFailed(error, action, expected),
    });
  }

  private clearOutcome(): void {
    this.writeError.set(null);
    this.writeFieldErrors.set({});
    this.confirmation.set(null);
  }

  /** Every captured assertion. Cleared together, so none can outlive its form. */
  private discardAction(): void {
    this.editing.set(null);
    this.expectedInvitationId.set(null);
    this.subject.set('');
    this.writeFieldErrors.set({});
    this.confirmation.set(null);
  }

  /**
   * A reissue landed. Adopt the canonical projection, release the slot, and show the
   * NEW credential once — replacing any earlier one on screen, which is dead now.
   *
   * ON A DESTROYED INSTANCE the projection is still adopted and the slot still released
   * — those are the workspace's — but the credential is dropped, and the workspace is told
   * WHICH invitation's code went unseen so the next tab can say so. See `orphanedWrite`.
   */
  private onReissued(result: OwnerInvitationReissueResult): void {
    this.workspace.adoptOnboarding(result.onboarding);
    this.workspace.endInvitationMutation();
    this.workspace.clearIndeterminateInvitationWrite();
    if (this.destroyed) {
      this.workspace.markCodeUnshown(result.owner_invitation.id);
      return;
    }
    this.workspace.clearCodeUnshown();
    this.discardAction();
    this.claimToken.set(result.owner_invitation.claim_token);
    this.issued.set({
      issued_at: result.owner_invitation.issued_at,
      expires_at: result.owner_invitation.expires_at,
    });
    this.writeError.set(null);
    this.confirmation.set('Claim code reissued. Any earlier code no longer works.');
    this.serviceStatus.markReachable();
  }

  /**
   * A cancellation landed. `changed: false` IS A SUCCESS — the exact retry the server
   * deliberately supports — and is described as nothing having moved, never as a new
   * decision. Any credential on screen belonged to the invitation just cancelled, so
   * it is cleared rather than left looking usable.
   */
  private onCancelled(result: OwnerInvitationCancelResult): void {
    this.workspace.adoptOnboarding(result.onboarding);
    this.workspace.endInvitationMutation();
    this.workspace.clearIndeterminateInvitationWrite();
    this.workspace.clearCodeUnshown();
    this.discardAction();
    this.claimToken.set(null);
    this.issued.set(null);
    this.writeError.set(null);
    this.confirmation.set(
      result.changed
        ? 'Owner invitation cancelled. The claim code no longer works.'
        : 'This invitation was already cancelled. Nothing was changed.',
    );
    this.serviceStatus.markReachable();
  }

  /**
   * Every failure that can reach an invitation write, told apart. The order matters:
   * the two elevation outcomes are client-side objects with no HTTP status, and a
   * conflict is a well-formed answer rather than a defect.
   */
  private onWriteFailed(error: unknown, action: InvitationAction, expected: string): void {
    this.workspace.endInvitationMutation();

    // Re-authentication dismissed. NOTHING was sent, so the draft is kept and the form
    // stays open.
    if (error instanceof ElevationCancelledError) {
      this.writeError.set('Re-authentication was cancelled. Nothing was changed.');
      return;
    }
    if (error instanceof ElevationAbandonedError) {
      this.writeError.set(
        'Re-authentication could not be completed, so nothing was changed. Try again once the admin service is reachable.',
      );
      return;
    }

    const status = readStatus(error);

    // THE CONCURRENCY OUTCOME. The head moved after this screen captured its id — or
    // the state it saw no longer supports the action. Not retried: replaying with a
    // fresh id would act on a credential the operator has never seen, which is the
    // exact thing `expected_invitation_id` exists to stop. The server's own curated
    // sentence is rendered — there are many distinct refusals and only it can tell
    // them apart — and any credential on screen may belong to a superseded invitation,
    // so it is cleared rather than left looking live.
    if (status === 409) {
      this.serviceStatus.markReachable();
      this.discardAction();
      this.claimToken.set(null);
      this.issued.set(null);
      this.writeError.set(
        `${extractErrorMessage(error, 'The owner invitation changed since it was loaded.')} ` +
          'Review the current invitation before trying again.',
      );
      this.workspace.reloadSuperseded();
      return;
    }

    // The restaurant is gone. The established not-found path takes the screen once the
    // re-read lands; until then nothing here may act on it.
    if (status === 404) {
      this.serviceStatus.markReachable();
      this.discardAction();
      this.claimToken.set(null);
      this.issued.set(null);
      this.workspace.reloadSuperseded();
      return;
    }

    // Validation. The form and the draft stay open, the server's words beside the
    // field they name.
    if (status === 400) {
      this.serviceStatus.markReachable();
      this.writeFieldErrors.set(extractFieldErrors(error));
      this.writeError.set(extractErrorMessage(error, 'The request could not be applied.'));
      return;
    }

    // No usable answer. INDETERMINATE — and for a REISSUE the consequence is specific:
    // the server may have rotated the credential and the only copy of the new code was
    // in the answer that never arrived. Nothing claims it failed, nothing retries, and
    // the projection is re-read before any further decision; what the re-read shows is
    // stated by `indeterminateResolution`.
    if (classifyTransportFailure(error) === 'unavailable') {
      this.serviceStatus.reportUnavailable(extractRequestId(error));
      this.discardAction();
      this.workspace.noteIndeterminateInvitationWrite({ action, expectedId: expected });
      this.writeError.set(
        action === 'reissue'
          ? 'The admin service did not answer, so it is not known whether a new claim code was issued.'
          : 'The admin service did not answer, so it is not known whether the invitation was cancelled.',
      );
      this.workspace.reloadSuperseded();
      return;
    }

    // A 401 is owned by the global classifier; anything else unexpected reaches the
    // defect machinery through the same interceptor. The operator is still told.
    this.serviceStatus.markReachable();
    this.writeError.set(extractErrorMessage(error, 'The request could not be applied.'));
  }
}
