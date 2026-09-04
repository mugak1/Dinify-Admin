import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from '../core/api/api.constants';
import { extractErrorMessage, extractNestedFieldErrors } from '../core/api/error-message';
import { AdminServiceStatus } from '../core/api/service-status';
import { classifyTransportFailure, extractRequestId } from '../core/api/transport-failure';
import { ElevationAbandonedError, ElevationCancelledError } from '../core/auth/elevation.service';
import { RESTAURANT_API } from '../core/restaurants/restaurant.api';
import {
  CreateRestaurantRequest,
  OwnerMode,
  OwnerSpec,
  RestaurantCreationResult,
} from '../core/restaurants/restaurant.model';
import { adminButtonClasses, AdminButtonComponent } from '../ui/button.component';
import { OwnerClaimCodeComponent } from './owner-claim-code.component';

/** The operator's explicit real/test decision. NO DEFAULT — see `is_test` below. */
type Classification = 'real' | 'test';

/**
 * What the success state keeps about the tenant it just created — the few SAFE facts
 * the screen renders, and deliberately not the canonical detail the response carried.
 * The workspace the operator opens next builds itself from the canonical GET.
 */
interface CreatedRestaurant {
  readonly id: string;
  readonly name: string;
  readonly isTest: boolean;
  readonly ownerAccountCreated: boolean;
  readonly invitationIssuedAt: string;
  readonly invitationExpiresAt: string;
}

/**
 * A 409 as this screen renders it: the server's sentence, its code, and the two UUIDs
 * the backend deliberately returns so an operator can act — the existing owner account
 * (`owner_account_already_exists` and the three account refusals) and the existing
 * restaurant (`restaurant_already_exists`). Never a name, phone or email: the conflict
 * body carries none, and this screen must not become an owner directory.
 */
interface CreationConflict {
  readonly code: string;
  readonly message: string;
  readonly ownerUserId: string | null;
  readonly restaurantId: string | null;
}

const PANEL = 'rounded-lg bg-surface p-6 ring-1 ring-line';
const LABEL = 'text-admin-label text-ink';
const NOTE = 'text-admin-meta text-ink-subtle';
const FIELD =
  'w-full rounded bg-surface px-2 py-1.5 text-admin-body text-ink ring-1 ring-inset ring-line-strong';
const ATTENTION = 'rounded-lg bg-admin-warning-soft p-4 ring-1 ring-inset ring-admin-warning/25';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request-body paths this form has a control for, per owner mode. */
const KNOWN_FIELDS: Record<OwnerMode, readonly string[]> = {
  new: [
    'restaurant.name',
    'restaurant.location',
    'restaurant.is_test',
    'owner.mode',
    'owner.first_name',
    'owner.last_name',
    'owner.phone_number',
    'owner.email',
    'reason',
  ],
  existing: [
    'restaurant.name',
    'restaurant.location',
    'restaurant.is_test',
    'owner.mode',
    'owner.user_id',
    'reason',
  ],
};

/**
 * CREATE RESTAURANT — `/restaurants/new` (Step 2G, over backend Step 2D).
 *
 * The operator side of the ownership chain that already exists end to end: this
 * screen creates a canonical tenant through `POST /restaurants/`, shows the one-time
 * owner claim code the server returns, and hands the operator off to the new
 * restaurant's workspace. The owner then claims in the restaurant portal, and the
 * workspace reports the consumed invitation and established control from the
 * canonical read.
 *
 * ── THE BODY IS BUILT, NEVER SPREAD ──────────────────────────────────────────────
 *
 * `buildRequest()` assembles a typed `CreateRestaurantRequest` from the chosen owner
 * mode's fields and nothing else. The backend refuses a `user_id` key beside
 * `mode: "new"` — and a `first_name` key beside `mode: "existing"` — by reading which
 * keys were SENT, blank or not, so spreading a form object that holds both drafts would
 * be a 400 at best and a hidden stale field at worst. The other mode's draft is kept in
 * memory (switching back must not lose it) and is unrepresentable on the wire.
 *
 * ── TWO DECISIONS HAVE NO DEFAULT ────────────────────────────────────────────────
 *
 * `is_test` decides whether this tenant appears in every revenue figure, and the owner
 * MODE decides whether an identity is minted or an existing person is attached. Both
 * are radios with nothing pre-selected: the server wants each stated by an operator,
 * and a defaulted "real" or a defaulted "new" would be this screen deciding.
 *
 * ── A COLLISION NEVER BECOMES A REUSE ────────────────────────────────────────────
 *
 * A phone already in use is a 409 naming ONLY the existing account's UUID. This screen
 * shows it, and offers ONE deliberate step — switch to the existing-account mode with
 * that UUID filled in — after which the operator reviews and submits again. Nothing
 * here switches modes on its own, and nothing resubmits.
 *
 * ── THE CLAIM CODE IS TRANSIENT, AND ONLY HERE ───────────────────────────────────
 *
 * The raw token from the 201 lives in `claimToken` — a signal on this component — for
 * as long as the success state is on screen, and is dropped on destroy. It is never
 * written to storage, a URL, router state, the workspace store, a notice or a log, and
 * no claim URL is fabricated from it. Leaving or refreshing loses it; the panel says so
 * and names the recovery (reissue from the workspace). A 201 that lands AFTER this
 * screen was left is dropped for the same reason, rather than parked somewhere that
 * outlives it.
 *
 * ── A LOST RESPONSE IS NOT A FAILURE ─────────────────────────────────────────────
 *
 * A 5xx or a dead socket after the POST is INDETERMINATE: the server may have committed
 * all six rows and the only copy of the credential was in the response that never
 * arrived. So this screen never says "creation failed", never re-POSTs on its own, and
 * tells the operator to look in the directory first — a restaurant that exists without
 * a known code is repaired by REISSUE, which is precisely why the backend built
 * reissue as rotation.
 *
 * ── WHAT CREATION DOES NOT DO ────────────────────────────────────────────────────
 *
 * It delivers nothing (the operator hands the code over), establishes no owner
 * control, makes nothing live (the restaurant starts `onboarding`, and go-live
 * readiness checks do not exist yet, so it cannot go live at all until they do), and
 * creates no commercial, readiness, menu, table, QR or lifecycle state.
 */
@Component({
  selector: 'app-restaurant-create-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AdminButtonComponent, OwnerClaimCodeComponent],
  template: `
    <header class="space-y-1">
      <a routerLink="/restaurants" class="text-admin-meta text-ink-muted hover:text-ink"
        >&larr; Restaurants</a
      >
      <h1 class="text-admin-page text-ink">Create restaurant</h1>
      <p class="max-w-prose text-admin-body text-ink-muted">
        A new tenant, its owner account and a one-time owner claim code. The code is shown
        to you once and you hand it to the owner yourself; Dinify does not deliver it.
      </p>
    </header>

    @if (created(); as done) {
      <!-- SUCCESS. The form is gone: the decision is made and must not be resubmitted
           from here. What remains is the hand-off and the way into the workspace. -->
      <section [class]="panel" aria-labelledby="created-heading" data-create-success>
        <h2 id="created-heading" class="text-admin-section text-ink">Restaurant created</h2>
        <p class="mt-1 max-w-prose text-admin-body text-ink">
          <span data-created-name>{{ done.name }}</span>
          @if (done.isTest) {
            <span> (test restaurant)</span>
          }
          is now onboarding.
          @if (done.ownerAccountCreated) {
            A new owner account was created for it, with no password yet.
          } @else {
            An existing owner account was attached to it and was not modified.
          }
        </p>

        @if (claimToken(); as token) {
          <app-owner-claim-code
            heading="Owner claim code"
            [claimToken]="token"
            [issuedAt]="done.invitationIssuedAt"
            [expiresAt]="done.invitationExpiresAt"
          >
            <!-- NAVIGATION, so an anchor. The workspace loads itself from the canonical
                 read; nothing from this response is carried into it. -->
            <a
              [routerLink]="['/restaurants', done.id, 'readiness']"
              [class]="primaryActionClasses"
              data-open-restaurant
              >Open the restaurant</a
            >
          </app-owner-claim-code>
        }

        <p class="mt-4 max-w-prose text-admin-meta text-ink-subtle">
          The restaurant cannot go live yet: it starts as onboarding, and go-live readiness
          checks are not configured. Owner control is established only once the owner
          redeems the claim code.
        </p>
      </section>
    } @else {
      <form (submit)="onSubmit($event)" novalidate class="space-y-4">
        <!-- A. THE RESTAURANT — three facts, deliberately not the model. -->
        <section [class]="panel" aria-labelledby="restaurant-facts-heading">
          <h2 id="restaurant-facts-heading" class="text-admin-section text-ink">Restaurant</h2>

          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1" for="create-name">
              <span [class]="label">Name</span>
              <input
                id="create-name"
                type="text"
                autocomplete="off"
                [value]="name()"
                [disabled]="pending()"
                (input)="name.set(readValue($event))"
                [class]="field"
                data-create-name
              />
              @for (message of errorsFor('restaurant.name'); track message) {
                <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                  message
                }}</span>
              }
            </label>

            <label class="flex flex-col gap-1" for="create-location">
              <span [class]="label">Location</span>
              <input
                id="create-location"
                type="text"
                autocomplete="off"
                [value]="location()"
                [disabled]="pending()"
                (input)="location.set(readValue($event))"
                [class]="field"
                data-create-location
              />
              @for (message of errorsFor('restaurant.location'); track message) {
                <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                  message
                }}</span>
              }
            </label>
          </div>

          <!-- THE TEST CLASSIFICATION. A real radiogroup with NOTHING pre-selected: the
               server refuses anything but an explicit JSON boolean, and this screen
               refuses to be the one that decides. Never inferred from the name. -->
          <fieldset class="mt-4">
            <legend [class]="label">Classification</legend>
            <div class="mt-2 space-y-2" role="radiogroup" aria-label="Classification">
              <label class="flex cursor-pointer gap-2">
                <input
                  type="radio"
                  name="classification"
                  value="real"
                  class="mt-0.5 h-4 w-4 shrink-0 accent-admin-accent"
                  [checked]="classification() === 'real'"
                  [disabled]="pending()"
                  (change)="classification.set('real')"
                  data-create-classification-real
                />
                <span class="flex flex-col gap-0.5">
                  <span [class]="label">Real restaurant</span>
                  <span [class]="note"
                    >A commercial customer. Counted in every portfolio and revenue figure.</span
                  >
                </span>
              </label>
              <label class="flex cursor-pointer gap-2">
                <input
                  type="radio"
                  name="classification"
                  value="test"
                  class="mt-0.5 h-4 w-4 shrink-0 accent-admin-accent"
                  [checked]="classification() === 'test'"
                  [disabled]="pending()"
                  (change)="classification.set('test')"
                  data-create-classification-test
                />
                <span class="flex flex-col gap-0.5">
                  <span [class]="label">Test restaurant</span>
                  <span [class]="note"
                    >A demo, fixture or rehearsal tenant. Excluded from every revenue figure;
                    every order it takes is commercially invisible.</span
                  >
                </span>
              </label>
            </div>
            @for (message of errorsFor('restaurant.is_test'); track message) {
              <p class="mt-1 text-admin-meta text-admin-danger" data-create-field-error>
                {{ message }}
              </p>
            }
          </fieldset>
        </section>

        <!-- B. THE OWNER — an explicit mode, and exactly that mode's fields. -->
        <section [class]="panel" aria-labelledby="owner-heading">
          <h2 id="owner-heading" class="text-admin-section text-ink">Owner</h2>
          <p class="mt-1 max-w-prose text-admin-meta text-ink-subtle">
            Phone number is the identity of a restaurant user. A number already in use is
            refused rather than reused — attaching that person is a separate, deliberate
            choice below.
          </p>

          <div class="mt-3 space-y-2" role="radiogroup" aria-label="Owner">
            <label class="flex cursor-pointer gap-2">
              <input
                type="radio"
                name="owner-mode"
                value="new"
                class="mt-0.5 h-4 w-4 shrink-0 accent-admin-accent"
                [checked]="ownerMode() === 'new'"
                [disabled]="pending()"
                (change)="ownerMode.set('new')"
                data-create-owner-new
              />
              <span class="flex flex-col gap-0.5">
                <span [class]="label">New owner</span>
                <span [class]="note"
                  >Creates a new owner account with no password. The owner chooses one when they
                  claim the restaurant.</span
                >
              </span>
            </label>
            <label class="flex cursor-pointer gap-2">
              <input
                type="radio"
                name="owner-mode"
                value="existing"
                class="mt-0.5 h-4 w-4 shrink-0 accent-admin-accent"
                [checked]="ownerMode() === 'existing'"
                [disabled]="pending()"
                (change)="ownerMode.set('existing')"
                data-create-owner-existing
              />
              <span class="flex flex-col gap-0.5">
                <span [class]="label">Existing account</span>
                <span [class]="note"
                  >Attaches an existing restaurant-user account by its exact account id. The
                  account is not modified.</span
                >
              </span>
            </label>
          </div>
          @for (message of errorsFor('owner.mode'); track message) {
            <p class="mt-1 text-admin-meta text-admin-danger" data-create-field-error>
              {{ message }}
            </p>
          }

          @if (ownerMode() === 'new') {
            <div class="mt-4 grid gap-3 sm:grid-cols-2" data-create-owner-new-fields>
              <label class="flex flex-col gap-1" for="create-first-name">
                <span [class]="label">First name</span>
                <input
                  id="create-first-name"
                  type="text"
                  autocomplete="off"
                  [value]="firstName()"
                  [disabled]="pending()"
                  (input)="firstName.set(readValue($event))"
                  [class]="field"
                  data-create-first-name
                />
                @for (message of errorsFor('owner.first_name'); track message) {
                  <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                    message
                  }}</span>
                }
              </label>

              <label class="flex flex-col gap-1" for="create-last-name">
                <span [class]="label">Last name</span>
                <input
                  id="create-last-name"
                  type="text"
                  autocomplete="off"
                  [value]="lastName()"
                  [disabled]="pending()"
                  (input)="lastName.set(readValue($event))"
                  [class]="field"
                  data-create-last-name
                />
                @for (message of errorsFor('owner.last_name'); track message) {
                  <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                    message
                  }}</span>
                }
              </label>

              <label class="flex flex-col gap-1" for="create-phone">
                <span [class]="label">Phone number</span>
                <input
                  id="create-phone"
                  type="text"
                  inputmode="tel"
                  autocomplete="off"
                  [value]="phone()"
                  [disabled]="pending()"
                  (input)="phone.set(readValue($event))"
                  [class]="field"
                  data-create-phone
                />
                <!-- Passed through as typed. Canonicalising a Ugandan number is the
                     server's job, and there is exactly one place that does it. -->
                <span [class]="note">Ugandan mobile number. Stored in canonical form.</span>
                @for (message of errorsFor('owner.phone_number'); track message) {
                  <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                    message
                  }}</span>
                }
              </label>

              <label class="flex flex-col gap-1" for="create-email">
                <span [class]="label">Email (optional)</span>
                <input
                  id="create-email"
                  type="text"
                  inputmode="email"
                  autocomplete="off"
                  [value]="email()"
                  [disabled]="pending()"
                  (input)="email.set(readValue($event))"
                  [class]="field"
                  data-create-email
                />
                <span [class]="note"
                  >Not an identity. An address another account already uses is refused.</span
                >
                @for (message of errorsFor('owner.email'); track message) {
                  <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                    message
                  }}</span>
                }
              </label>
            </div>
          }

          @if (ownerMode() === 'existing') {
            <div class="mt-4" data-create-owner-existing-fields>
              <label class="flex flex-col gap-1" for="create-user-id">
                <span [class]="label">Owner account id</span>
                <input
                  id="create-user-id"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  [value]="userId()"
                  [disabled]="pending()"
                  (input)="userId.set(readValue($event))"
                  [class]="field + ' tabular-figures'"
                  data-create-user-id
                />
                <span [class]="note"
                  >The account’s UUID, as Dinify Admin shows it — for example on the message
                  shown when a phone number is already in use. There is no account search.</span
                >
                @for (message of errorsFor('owner.user_id'); track message) {
                  <span class="text-admin-meta text-admin-danger" data-create-field-error>{{
                    message
                  }}</span>
                }
              </label>
            </div>
          }
        </section>

        <!-- C. THE REASON — the operator's own, recorded on the audit row. -->
        <section [class]="panel" aria-labelledby="reason-heading">
          <h2 id="reason-heading" class="text-admin-section text-ink">Reason</h2>
          <label class="mt-3 flex flex-col gap-1" for="create-reason">
            <span [class]="label">Why this restaurant is being created</span>
            <textarea
              id="create-reason"
              rows="2"
              [attr.minlength]="minReason"
              [attr.maxlength]="maxReason"
              [value]="reason()"
              [disabled]="pending()"
              (input)="reason.set(readValue($event))"
              [class]="field"
              data-create-reason
            ></textarea>
          </label>
          <p [class]="'mt-1 ' + note">
            Recorded in the Admin audit log. At least {{ minReason }} characters.
          </p>
          @for (message of errorsFor('reason'); track message) {
            <p class="mt-1 text-admin-meta text-admin-danger" data-create-field-error>
              {{ message }}
            </p>
          }
        </section>

        <!-- D. OUTCOMES THAT ARE NOT A FIELD. Each is its own state, never collapsed. -->
        @if (conflict(); as conflict) {
          <section [class]="attention" role="alert" data-create-conflict>
            <h2 class="text-admin-section text-ink">Not created</h2>
            <p class="mt-1 max-w-prose text-admin-body text-ink" data-create-conflict-message>
              {{ conflict.message }}
            </p>

            @if (conflict.ownerUserId; as userId) {
              <p class="mt-2 text-admin-meta text-ink-muted">
                Account id
                <span class="tabular-figures" data-create-conflict-owner-id>{{ userId }}</span>
              </p>
              @if (conflict.code === 'owner_account_already_exists') {
                <!-- THE ONE RECOVERY STEP, AND IT IS THE OPERATOR'S. Nothing was reused:
                     the collision is shown, the id is shown, and switching modes with
                     that id filled in is a choice they make and then submit again. -->
                <p class="mt-2 max-w-prose text-admin-meta text-ink-muted">
                  Nothing was reused automatically. If that account is the intended owner,
                  switch to it and create the restaurant again; the new-owner details will
                  not be sent.
                </p>
                <div class="mt-3">
                  <app-admin-button
                    variant="secondary"
                    (pressed)="useExistingAccount(userId)"
                    data-create-use-existing
                    >Use this existing account</app-admin-button
                  >
                </div>
              }
            }

            @if (conflict.restaurantId; as restaurantId) {
              <p class="mt-2 max-w-prose text-admin-meta text-ink-muted">
                If it was created a moment ago and no claim code was shown, open it and
                reissue the claim code from its Readiness tab.
              </p>
              <div class="mt-3">
                <a
                  [routerLink]="['/restaurants', restaurantId, 'readiness']"
                  [class]="secondaryActionClasses"
                  data-create-open-existing
                  >Open the existing restaurant</a
                >
              </div>
            }
          </section>
        }

        @if (indeterminate()) {
          <!-- NOT "creation failed". The server may have committed and the only copy of
               the credential may have been in the answer that never arrived. -->
          <section [class]="attention" role="alert" data-create-indeterminate>
            <h2 class="text-admin-section text-ink">Outcome unknown</h2>
            <p class="mt-1 max-w-prose text-admin-body text-ink">
              The admin service did not answer, so it is not known whether the restaurant was
              created. Nothing was retried automatically.
            </p>
            <p class="mt-2 max-w-prose text-admin-meta text-ink-muted">
              Before deciding what to do next, look for it in the Restaurants directory. If it
              is there but no claim code was shown, open it and reissue the claim code from its
              Readiness tab. If it is not there, create it again.
            </p>
            <div class="mt-3">
              <a
                routerLink="/restaurants"
                [queryParams]="{ search: name().trim() || null }"
                [class]="secondaryActionClasses"
                data-create-look-in-directory
                >Look for it in the directory</a
              >
            </div>
          </section>
        }

        @for (message of otherErrors(); track message) {
          <p class="max-w-prose text-admin-meta text-admin-danger" data-create-field-error>
            {{ message }}
          </p>
        }

        @if (formError(); as message) {
          <p class="max-w-prose text-admin-body text-admin-danger" data-create-error>
            {{ message }}
          </p>
        }

        <div class="flex flex-wrap items-center gap-2">
          <!-- The pending state is the §16 mechanism: visibly in flight until the server
               has committed AND audited the creation. A SUBMIT button with no click
               handler of its own: the form's submit event is the one path in, so a click
               and an Enter keypress cannot become two requests. -->
          <app-admin-button
            type="submit"
            variant="primary"
            [disabled]="!canSubmit()"
            [pending]="pending()"
            data-create-submit
            >Create restaurant</app-admin-button
          >
          <a routerLink="/restaurants" [class]="ghostActionClasses">Cancel</a>
        </div>
      </form>
    }
  `,
})
export class RestaurantCreatePage {
  private readonly api = inject(RESTAURANT_API);
  private readonly serviceStatus = inject(AdminServiceStatus);

  protected readonly panel = PANEL;
  protected readonly label = LABEL;
  protected readonly note = NOTE;
  protected readonly field = FIELD;
  protected readonly attention = ATTENTION;
  protected readonly minReason = MIN_REASON_LENGTH;
  protected readonly maxReason = MAX_REASON_LENGTH;
  protected readonly primaryActionClasses = adminButtonClasses('primary');
  protected readonly secondaryActionClasses = adminButtonClasses('secondary');
  protected readonly ghostActionClasses = adminButtonClasses('ghost');

  // --- the draft -----------------------------------------------------------------

  protected readonly name = signal('');
  protected readonly location = signal('');
  protected readonly classification = signal<Classification | null>(null);
  protected readonly ownerMode = signal<OwnerMode | null>(null);
  protected readonly firstName = signal('');
  protected readonly lastName = signal('');
  protected readonly phone = signal('');
  protected readonly email = signal('');
  protected readonly userId = signal('');
  protected readonly reason = signal('');

  /**
   * In flight. Local, because creation is not workspace-scoped: there is no restaurant
   * yet for a sibling route to share a slot for, and this screen is the only writer.
   */
  protected readonly pending = signal(false);

  // --- the outcome ---------------------------------------------------------------

  protected readonly created = signal<CreatedRestaurant | null>(null);
  /** THE RAW CREDENTIAL. Transient, this component only, cleared on destroy. */
  protected readonly claimToken = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  /** Dotted request-body paths — `owner.phone_number`, `reason`, `__all__`. */
  protected readonly fieldErrors = signal<Record<string, readonly string[]>>({});
  protected readonly conflict = signal<CreationConflict | null>(null);
  protected readonly indeterminate = signal(false);

  /** Set on destroy, so a 201 that lands afterwards has nowhere to put its credential. */
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      // Dropped, not parked. The panel told the operator this would happen.
      this.claimToken.set(null);
    });
  }

  /**
   * Every fact stated, and a substantive reason. ADVISORY — the server stays
   * authoritative and a 400 from it still renders beside the field it names. This
   * exists so an operator is told before submitting rather than after.
   */
  protected readonly canSubmit = computed(() => {
    if (this.pending()) return false;
    if (!this.name().trim() || !this.location().trim()) return false;
    if (this.classification() === null) return false;
    const mode = this.ownerMode();
    if (mode === null) return false;
    if (mode === 'new') {
      if (!this.firstName().trim() || !this.lastName().trim() || !this.phone().trim()) {
        return false;
      }
    } else if (!UUID.test(this.userId().trim())) {
      return false;
    }
    return this.reason().trim().length >= MIN_REASON_LENGTH;
  });

  protected readValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected errorsFor(path: string): readonly string[] {
    return this.fieldErrors()[path] ?? [];
  }

  /**
   * Server errors naming something this form has no control for in its CURRENT mode —
   * `__all__`, a field of the other mode, or a path a future contract adds. Shown rather
   * than dropped: a 400 the server bothered to attribute is the server telling the
   * operator something real, and swallowing it leaves a form that refuses silently.
   */
  protected otherErrors(): readonly string[] {
    const mode = this.ownerMode();
    const known = new Set(mode === null ? KNOWN_FIELDS.new : KNOWN_FIELDS[mode]);
    return Object.entries(this.fieldErrors())
      .filter(([path]) => !known.has(path))
      .flatMap(([, messages]) => messages);
  }

  protected onSubmit(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  protected submit(): void {
    if (this.pending()) return;
    const request = this.buildRequest();
    if (request === null) return;

    this.pending.set(true);
    this.clearOutcome();

    // Ordinary HttpClient underneath: a 403 for stale elevation opens ONE dialog and
    // replays THIS request — this exact body, `is_test` and reason included — once.
    this.api.createRestaurant(request).subscribe({
      next: (result) => this.onCreated(result),
      error: (error: unknown) => this.onFailed(error),
    });
  }

  /**
   * The exact wire body, from the chosen mode's fields and nothing else.
   *
   * `email` is sent as an explicit `null` when blank — the contract lets a client state
   * an absence rather than omit the key — and `is_test` is the boolean the operator
   * chose. Neither is a form default.
   */
  private buildRequest(): CreateRestaurantRequest | null {
    if (!this.canSubmit()) return null;
    const classification = this.classification();
    const mode = this.ownerMode();
    if (classification === null || mode === null) return null;

    return {
      restaurant: {
        name: this.name().trim(),
        location: this.location().trim(),
        is_test: classification === 'test',
      },
      owner: this.buildOwner(mode),
      reason: this.reason().trim(),
    };
  }

  /** Exactly the chosen mode's keys. The other mode's draft is unrepresentable here. */
  private buildOwner(mode: OwnerMode): OwnerSpec {
    if (mode === 'existing') {
      return { mode: 'existing', user_id: this.userId().trim() };
    }
    const email = this.email().trim();
    return {
      mode: 'new',
      first_name: this.firstName().trim(),
      last_name: this.lastName().trim(),
      phone_number: this.phone().trim(),
      email: email === '' ? null : email,
    };
  }

  /**
   * THE ONE RECOVERY STEP after `owner_account_already_exists`: switch the mode and
   * fill the id. It does NOT submit — the operator reviews the whole form and creates
   * again — and it does not clear the new-owner draft, which simply stops being sent.
   */
  protected useExistingAccount(userId: string): void {
    this.ownerMode.set('existing');
    this.userId.set(userId);
    this.conflict.set(null);
    this.fieldErrors.set({});
    this.formError.set(null);
  }

  private clearOutcome(): void {
    this.formError.set(null);
    this.fieldErrors.set({});
    this.conflict.set(null);
    this.indeterminate.set(false);
  }

  private onCreated(result: RestaurantCreationResult): void {
    this.pending.set(false);
    // The server answered, so the control plane is reachable. Mock mode runs no
    // interceptor, so without this a mocked outage would never clear.
    this.serviceStatus.markReachable();
    // A response that outlived the screen has no home for its credential. Dropping it
    // here is the honest outcome: the restaurant exists, the code is unknown, and the
    // workspace's reissue is the repair.
    if (this.destroyed) return;

    this.created.set({
      id: result.restaurant.id,
      name: result.restaurant.name,
      isTest: result.restaurant.is_test,
      ownerAccountCreated: result.owner_account.created,
      invitationIssuedAt: result.owner_invitation.issued_at,
      invitationExpiresAt: result.owner_invitation.expires_at,
    });
    this.claimToken.set(result.owner_invitation.claim_token);
  }

  /**
   * Every failure that can reach a creation, told apart. The order matters: the two
   * elevation outcomes are client-side objects with no HTTP status, and a conflict is a
   * well-formed answer rather than a defect.
   */
  private onFailed(error: unknown): void {
    this.pending.set(false);

    // Re-authentication dismissed. NOTHING was sent, so the whole draft is kept.
    if (error instanceof ElevationCancelledError) {
      this.formError.set('Re-authentication was cancelled. Nothing was created.');
      return;
    }
    if (error instanceof ElevationAbandonedError) {
      this.formError.set(
        'Re-authentication could not be completed, so nothing was created. Try again once the admin service is reachable.',
      );
      return;
    }

    const status = readStatus(error);

    // A well-formed request the platform's current state contradicts. The remedy is to
    // look and decide again — which is what the panel offers — never a blind resubmit.
    if (status === 409) {
      this.serviceStatus.markReachable();
      this.conflict.set(readConflict(error));
      return;
    }

    // Validation. The form and the draft stay, with the server's words beside the
    // field each names.
    if (status === 400) {
      this.serviceStatus.markReachable();
      this.fieldErrors.set(extractNestedFieldErrors(error));
      this.formError.set(extractErrorMessage(error, 'The restaurant could not be created.'));
      return;
    }

    // No usable answer. INDETERMINATE — see the class comment. The draft is preserved
    // for a deliberate decision, and nothing is retried here.
    if (classifyTransportFailure(error) === 'unavailable') {
      this.serviceStatus.reportUnavailable(extractRequestId(error));
      this.indeterminate.set(true);
      return;
    }

    // A 401 is owned by the global classifier; anything else unexpected reaches the
    // defect machinery through the same interceptor. The operator is still told.
    this.serviceStatus.markReachable();
    this.formError.set(extractErrorMessage(error, 'The restaurant could not be created.'));
  }
}

/** Duck-typed, for the same reason `classifyTransportFailure` is: mock errors are not `HttpErrorResponse`. */
function readStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)['status'];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The 409 body as this screen needs it. Reads `code`, the sentence, and the two UUIDs
 * the backend puts under `details` — and nothing else, because nothing else is there.
 */
function readConflict(error: unknown): CreationConflict {
  const body = isRecord(error) ? error['error'] : null;
  const code = isRecord(body) && typeof body['code'] === 'string' ? body['code'] : 'conflict';
  const details = isRecord(body) && isRecord(body['details']) ? body['details'] : {};
  return {
    code,
    message: extractErrorMessage(error, 'The restaurant could not be created as described.'),
    ownerUserId: readUuid(details['owner_user_id']),
    restaurantId: readUuid(details['restaurant_id']),
  };
}

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
