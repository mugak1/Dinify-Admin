import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, fakeAsync, flush, flushMicrotasks, tick } from '@angular/core/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../core/api/service-status';
import { ElevationCancelledError } from '../core/auth/elevation.service';
import { RESTAURANT_API, RestaurantApi } from '../core/restaurants/restaurant.api';
import {
  CreateRestaurantRequest,
  RestaurantCreationResult,
  RestaurantDetail,
} from '../core/restaurants/restaurant.model';
import { RestaurantCreatePage } from './restaurant-create.page';

const CREATED_ID = '9a7f1cf0-4b2e-4f3a-9c1d-f00000000001';
const OWNER_ID = '1f2e3d4c-5b6a-4978-8899-f00000000001';
const EXISTING_OWNER_ID = '1f2e3d4c-5b6a-4978-8899-000000000002';
const INVITATION_ID = '4d5e6f70-8192-4a3b-9c4d-f00000000001';
const REQUEST_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
/** A raw claim code, shaped like `secrets.token_urlsafe(48)` — 64 base64url characters. */
const TOKEN = 'Zx9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOpQrStUvWxYz0';
const REASON = 'Signed pilot agreement, March cohort';

/** Not an `HttpErrorResponse`: everything must classify by duck-typing. */
class WireError extends Error {
  readonly headers = {
    get: (name: string) => (name === 'X-Request-ID' ? REQUEST_ID : null),
  };
  constructor(
    readonly status: number,
    readonly error: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
}

/** The canonical detail of a restaurant that was created a moment ago. */
function createdDetail(overrides: Partial<RestaurantDetail> = {}): RestaurantDetail {
  return {
    id: CREATED_ID,
    name: 'Speke Road Cafe',
    location: 'Kampala',
    status: 'onboarding',
    is_test: false,
    readiness: { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'] },
    commercial: {
      payment_timing: { configured: false, value: null, set_at: null },
      payment_collection_mode: { configured: false, value: null, set_at: null },
      subscription_terms: { configured: false, current: null },
    },
    payment_mode: null,
    payment_mode_configured: false,
    subscription: {
      source: 'legacy_restaurant_fields',
      has_commercial_subscription: false,
      legacy_validity_flag: true,
      legacy_expiry_at: null,
      preferred_method: 'per_order',
    },
    last_activity_at: '2026-08-25T09:00:00+00:00',
    needs_attention: true,
    allowed_transitions: ['live', 'offboarded'],
    created_at: '2026-08-25T09:00:00+00:00',
    owner: {
      id: OWNER_ID,
      name: 'Miriam Nakato',
      email: null,
      phone_number: '256772140388',
      is_active: true,
      claim_tracked: true,
      claim_status: 'not_established',
    },
    onboarding: {
      tracked: true,
      source: 'admin_created',
      recorded_at: '2026-08-25T09:00:00+00:00',
      owner_relationship: { status: 'consistent' },
      owner_control: { status: 'not_established', evidence: null, evidence_at: null },
      invitation: {
        status: 'pending',
        id: INVITATION_ID,
        issued_at: '2026-08-25T09:00:00+00:00',
        expires_at: '2026-09-01T09:00:00+00:00',
      },
    },
    support: { open_issue_count: 0 },
    operations: { table_count: 0, usable_table_count: 0, dining_area_count: 0, latest_order: null },
    recent_activity: [],
    ...overrides,
  };
}

/** The 201 payload, as `restaurant_creation.success_body` builds it. */
function created(overrides: Partial<RestaurantCreationResult> = {}): RestaurantCreationResult {
  return {
    restaurant: createdDetail(),
    owner_account: { id: OWNER_ID, created: true },
    owner_invitation: {
      id: INVITATION_ID,
      issued_at: '2026-08-25T09:00:00+00:00',
      expires_at: '2026-09-01T09:00:00+00:00',
      claim_token: TOKEN,
    },
    ...overrides,
  };
}

class StubApi implements RestaurantApi {
  /** Every creation attempted, in order, as the EXACT object handed to the port. */
  readonly creations: CreateRestaurantRequest[] = [];
  createAnswer: () => Observable<RestaurantCreationResult> = () => of(created());

  createRestaurant(request: CreateRestaurantRequest): Observable<RestaurantCreationResult> {
    this.creations.push(request);
    return this.createAnswer();
  }

  // THE CREATION SCREEN READS NOTHING AND WRITES NOTHING ELSE. There is no restaurant
  // yet to read, no owner directory to search, and no invitation to manage.
  list(): Observable<never> {
    throw new Error('the creation screen must not read the directory');
  }
  detail(): Observable<never> {
    throw new Error('the creation screen must not read a detail');
  }
  setPaymentTiming(): Observable<never> {
    throw new Error('the creation screen must not write commercial state');
  }
  setPaymentCollectionMode(): Observable<never> {
    throw new Error('the creation screen must not write commercial state');
  }
  recordSubscriptionTerms(): Observable<never> {
    throw new Error('the creation screen must not write commercial state');
  }
  replaceSubscriptionTerms(): Observable<never> {
    throw new Error('the creation screen must not write commercial state');
  }
  endSubscriptionTerms(): Observable<never> {
    throw new Error('the creation screen must not write commercial state');
  }
  reissueOwnerInvitation(): Observable<never> {
    throw new Error('the creation screen must not write an owner invitation');
  }
  cancelOwnerInvitation(): Observable<never> {
    throw new Error('the creation screen must not write an owner invitation');
  }
}

@Component({
  selector: 'app-landing-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: 'landing',
})
class LandingStub {}

/**
 * CREATE RESTAURANT — `/restaurants/new` (Step 2G, over backend Step 2D).
 *
 * What these specs hold, in one sentence each:
 *
 *   THE BODY IS THE CONTRACT. `is_test` is a JSON boolean the operator chose, the owner
 *   block carries exactly the chosen mode's keys, a blank email is an explicit null, and
 *   nothing is defaulted on the operator's behalf.
 *
 *   A COLLISION NEVER BECOMES A REUSE. A phone already in use is shown with the account's
 *   id; switching to that account is ONE deliberate step the operator takes, and nothing
 *   is resubmitted for them.
 *
 *   THE CLAIM CODE IS TRANSIENT. Shown once in a copyable field, held in this component
 *   only, never in storage, a URL, an anchor or a store — and dropped when the screen is
 *   left, including for a response that arrives afterwards.
 *
 *   A LOST ANSWER IS NOT A FAILURE. The screen never says "failed", never retries, and
 *   points at the directory first.
 *
 *   NOTHING IS SENT. The vocabulary is issue and hand over — never send, resend,
 *   delivered — and no claim link exists to be copied.
 */
describe('RestaurantCreatePage', () => {
  let harness: RouterTestingHarness;
  let api: StubApi;
  let status: AdminServiceStatus;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: 'restaurants/new', component: RestaurantCreatePage },
            { path: 'restaurants', component: LandingStub },
            {
              path: 'restaurants/:id',
              component: LandingStub,
              children: [{ path: 'readiness', component: LandingStub }],
            },
          ],
          withComponentInputBinding(),
        ),
        { provide: RESTAURANT_API, useValue: api },
      ],
    });
    status = TestBed.inject(AdminServiceStatus);
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  async function open(): Promise<void> {
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/restaurants/new', RestaurantCreatePage);
    harness.detectChanges();
  }

  function el(): HTMLElement {
    return harness.routeDebugElement?.nativeElement as HTMLElement;
  }
  function text(): string {
    return el().textContent ?? '';
  }
  function field<T extends HTMLElement = HTMLInputElement>(attribute: string): T {
    const found = el().querySelector<T>(`[${attribute}]`);
    expect(found).withContext(attribute).toBeTruthy();
    return found as T;
  }
  function type(attribute: string, value: string): void {
    const input = field<HTMLInputElement | HTMLTextAreaElement>(attribute);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    harness.detectChanges();
  }
  function choose(attribute: string): void {
    field(attribute).click();
    harness.detectChanges();
  }
  function submitButton(): HTMLButtonElement {
    return field<HTMLButtonElement>('data-create-submit').querySelector('button')!;
  }
  function submit(): void {
    // A real click on the SUBMIT button, so the form's submit event — the one path in —
    // is what fires. There is deliberately no click handler on the button itself.
    submitButton().click();
    harness.detectChanges();
  }
  function fillRestaurant(): void {
    type('data-create-name', 'Speke Road Cafe');
    type('data-create-location', 'Kampala');
    choose('data-create-classification-real');
  }
  function fillNewOwner(): void {
    choose('data-create-owner-new');
    type('data-create-first-name', 'Miriam');
    type('data-create-last-name', 'Nakato');
    type('data-create-phone', '0772140388');
  }
  function fillEverything(): void {
    fillRestaurant();
    fillNewOwner();
    type('data-create-reason', REASON);
  }
  function codeValue(): string | null {
    return el().querySelector<HTMLInputElement>('[data-claim-code]')?.value ?? null;
  }
  /** Every place a credential could have leaked to, in one sweep. */
  function tokenIsNowhereBut(shown: boolean): void {
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(storage.getItem(key) ?? '').withContext(`storage ${key}`).not.toContain(TOKEN);
      }
    }
    expect(TestBed.inject(Router).url).withContext('the URL').not.toContain(TOKEN);
    for (const anchor of Array.from(el().querySelectorAll('a'))) {
      expect(anchor.getAttribute('href') ?? '').withContext('an anchor').not.toContain(TOKEN);
    }
    expect(text()).withContext('prose').not.toContain(TOKEN);
    expect(el().innerHTML).withContext('markup').not.toContain(TOKEN);
    expect(codeValue() === TOKEN).withContext('the readonly field').toBe(shown);
  }

  // ── THE FORM ─────────────────────────────────────────────────────────────────────

  it('pre-selects NEITHER the classification NOR the owner mode', fakeAsync(async () => {
    // Two decisions with no default. `is_test` decides whether the tenant appears in
    // every revenue figure and the mode decides whether an identity is minted; the
    // server wants each stated by an operator, and a defaulted radio would be this
    // screen deciding.
    await open();

    for (const radio of Array.from(el().querySelectorAll<HTMLInputElement>('input[type="radio"]'))) {
      expect(radio.checked).withContext(radio.value).toBeFalse();
    }
    expect(el().querySelector('[data-create-owner-new-fields]')).toBeNull();
    expect(el().querySelector('[data-create-owner-existing-fields]')).toBeNull();
    expect(submitButton().disabled).toBeTrue();
    flush();
  }));

  it('shows exactly the chosen mode’s fields, and keeps the other mode’s draft', fakeAsync(async () => {
    await open();

    choose('data-create-owner-new');
    expect(el().querySelector('[data-create-owner-new-fields]')).toBeTruthy();
    expect(el().querySelector('[data-create-owner-existing-fields]')).toBeNull();
    type('data-create-first-name', 'Miriam');

    choose('data-create-owner-existing');
    expect(el().querySelector('[data-create-owner-new-fields]')).toBeNull();
    expect(el().querySelector('[data-create-owner-existing-fields]')).toBeTruthy();

    choose('data-create-owner-new');
    expect(field('data-create-first-name').value).withContext('the draft survived').toBe('Miriam');
    flush();
  }));

  it('keeps Create unavailable until every fact AND a substantive reason are stated', fakeAsync(async () => {
    await open();
    fillRestaurant();
    fillNewOwner();
    expect(submitButton().disabled).withContext('no reason').toBeTrue();

    type('data-create-reason', 'too short');
    expect(submitButton().disabled).withContext('short reason').toBeTrue();

    type('data-create-reason', REASON);
    expect(submitButton().disabled).toBeFalse();

    choose('data-create-owner-existing');
    expect(submitButton().disabled).withContext('existing mode with no id').toBeTrue();
    type('data-create-user-id', 'not-a-uuid');
    expect(submitButton().disabled).withContext('a malformed id').toBeTrue();
    type('data-create-user-id', EXISTING_OWNER_ID);
    expect(submitButton().disabled).toBeFalse();
    expect(api.creations.length).toBe(0);
    flush();
  }));

  // ── THE BODY ─────────────────────────────────────────────────────────────────────

  it('sends EXACTLY the contract for a new owner: a boolean is_test, the mode’s keys, a null email', fakeAsync(async () => {
    await open();
    fillEverything();

    submit();

    expect(api.creations.length).toBe(1);
    expect(api.creations[0]).toEqual({
      restaurant: { name: 'Speke Road Cafe', location: 'Kampala', is_test: false },
      owner: {
        mode: 'new',
        first_name: 'Miriam',
        last_name: 'Nakato',
        phone_number: '0772140388',
        email: null,
      },
      reason: REASON,
    });
    // KEY PRESENCE, not merely value: the server reads which keys were SENT.
    expect(Object.keys(api.creations[0].owner)).toEqual([
      'mode',
      'first_name',
      'last_name',
      'phone_number',
      'email',
    ]);
    const wire = JSON.stringify(api.creations[0]);
    expect(wire).toContain('"is_test":false');
    expect(wire).toContain('"email":null');
    flush();
  }));

  it('sends is_test:true as a boolean when the operator chose Test, and passes the email through', fakeAsync(async () => {
    await open();
    type('data-create-name', 'Dinify Demo Kitchen');
    type('data-create-location', 'Internal');
    choose('data-create-classification-test');
    fillNewOwner();
    type('data-create-email', 'ops@dinifyapp.com');
    type('data-create-reason', REASON);

    submit();

    expect(api.creations[0].restaurant.is_test).toBe(true);
    expect(JSON.stringify(api.creations[0])).toContain('"is_test":true');
    expect((api.creations[0].owner as { email: string | null }).email).toBe('ops@dinifyapp.com');
    flush();
  }));

  it('sends EXACTLY {mode, user_id} for an existing owner — no new-owner key, blank or not', fakeAsync(async () => {
    await open();
    fillRestaurant();
    // A new-owner draft exists and is NOT sent: the server refuses a `first_name` key
    // beside `mode: "existing"` even when its value is blank.
    fillNewOwner();
    choose('data-create-owner-existing');
    type('data-create-user-id', ` ${EXISTING_OWNER_ID} `);
    type('data-create-reason', REASON);

    submit();

    expect(api.creations[0].owner).toEqual({ mode: 'existing', user_id: EXISTING_OWNER_ID });
    expect(Object.keys(api.creations[0].owner)).toEqual(['mode', 'user_id']);
    flush();
  }));

  it('passes the phone number through AS TYPED — canonicalising it is the server’s job', fakeAsync(async () => {
    await open();
    fillRestaurant();
    choose('data-create-owner-new');
    type('data-create-first-name', 'Miriam');
    type('data-create-last-name', 'Nakato');
    type('data-create-phone', '+256 772 140 388');
    type('data-create-reason', REASON);

    submit();

    expect((api.creations[0].owner as { phone_number: string }).phone_number).toBe('+256 772 140 388');
    flush();
  }));

  it('submits ONCE per click, through the form, and shuts the form while in flight', fakeAsync(async () => {
    const pending = new Subject<RestaurantCreationResult>();
    api.createAnswer = () => pending;
    await open();
    fillEverything();

    submit();
    expect(api.creations.length).toBe(1);
    expect(submitButton().disabled).withContext('pending').toBeTrue();
    expect(submitButton().getAttribute('aria-busy')).toBe('true');
    expect(field('data-create-name').disabled).toBeTrue();
    expect(field<HTMLTextAreaElement>('data-create-reason').disabled).toBeTrue();

    submit();
    expect(api.creations.length).withContext('a second click sends nothing').toBe(1);

    pending.next(created());
    pending.complete();
    harness.detectChanges();
    expect(el().querySelector('[data-create-success]')).toBeTruthy();
    flush();
  }));

  // ── SUCCESS, AND THE ONE-TIME CODE ───────────────────────────────────────────────

  it('replaces the form with the hand-off: the code in a copyable field, the warning, and the way in', fakeAsync(async () => {
    await open();
    fillEverything();

    submit();

    expect(el().querySelector('form')).withContext('the decision is made; no resubmit from here').toBeNull();
    const success = el().querySelector('[data-create-success]')!;
    expect(success.textContent).toContain('Restaurant created');
    expect(el().querySelector('[data-created-name]')?.textContent?.trim()).toBe('Speke Road Cafe');
    expect(success.textContent).toContain('is now onboarding');
    expect(success.textContent).toContain('A new owner account was created for it, with no password yet.');

    expect(codeValue()).toBe(TOKEN);
    expect(el().querySelector<HTMLInputElement>('[data-claim-code]')!.readOnly).toBeTrue();
    expect(success.textContent).toContain('Shown once');
    expect(success.textContent).toContain('cannot be retrieved after you leave this screen');
    expect(success.textContent).toContain('reissue a new code');
    expect(el().querySelector('[data-claim-code-window]')?.textContent).toContain('Issued');

    // The way in is a NAVIGATION to the canonical workspace, and the credential does
    // not ride it.
    const open_ = el().querySelector<HTMLAnchorElement>('[data-open-restaurant]')!;
    expect(open_.tagName).toBe('A');
    expect(open_.getAttribute('href')).toBe(`/restaurants/${CREATED_ID}/readiness`);
    flush();
  }));

  it('describes an existing owner as attached and unmodified', fakeAsync(async () => {
    api.createAnswer = () => of(created({ owner_account: { id: EXISTING_OWNER_ID, created: false } }));
    await open();
    fillRestaurant();
    choose('data-create-owner-existing');
    type('data-create-user-id', EXISTING_OWNER_ID);
    type('data-create-reason', REASON);

    submit();

    expect(text()).toContain('An existing owner account was attached to it and was not modified.');
    expect(text()).not.toContain('A new owner account was created');
    flush();
  }));

  it('marks a test restaurant as one, from the canonical detail', fakeAsync(async () => {
    api.createAnswer = () =>
      of(created({ restaurant: createdDetail({ name: 'Dinify Demo Kitchen', is_test: true }) }));
    await open();
    fillEverything();

    submit();

    expect(el().querySelector('[data-create-success]')!.textContent).toContain('Dinify Demo Kitchen (test restaurant)');
    flush();
  }));

  it('claims nothing beyond what creation did: not live, not delivered, not controlled', fakeAsync(async () => {
    await open();
    fillEverything();
    submit();

    const shown = text();
    expect(shown).toContain('cannot go live yet');
    expect(shown).toContain('readiness checks are not configured');
    expect(shown).toContain('Owner control is established only once the owner redeems the claim code');
    expect(shown).toContain('Dinify does not deliver it');
    // ISSUANCE IS NOT DELIVERY, in both states of the screen.
    expect(shown).not.toMatch(/\b(sent|resend|resent|delivered|delivery failed|SMS|emailed)\b/i);
    expect(shown).not.toContain('claim link');
    expect(shown).not.toContain('Copy link');
    expect(shown).not.toContain('Send invitation');
    // No claim URL is fabricated: the portal's screen is NAMED, never linked with a token.
    for (const anchor of Array.from(el().querySelectorAll('a'))) {
      expect(anchor.getAttribute('href') ?? '').not.toContain('owner-claim');
    }
    flush();
  }));

  it('holds the raw code in THIS COMPONENT and nowhere else', fakeAsync(async () => {
    await open();
    fillEverything();
    submit();

    tokenIsNowhereBut(true);
    flush();
  }));

  it('copies the EXACT code, and reports a clipboard that refuses', fakeAsync(async () => {
    await open();
    fillEverything();
    submit();

    const writes: string[] = [];
    let refuse = false;
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => {
          writes.push(value);
          return refuse ? Promise.reject(new Error('denied')) : Promise.resolve();
        },
      },
    });
    try {
      el().querySelector<HTMLButtonElement>('[data-claim-copy] button')!.click();
      flushMicrotasks();
      harness.detectChanges();
      expect(writes).toEqual([TOKEN]);
      expect(text()).toContain('Copied to the clipboard.');

      refuse = true;
      el().querySelector<HTMLButtonElement>('[data-claim-copy] button')!.click();
      flushMicrotasks();
      harness.detectChanges();
      expect(text()).toContain('The clipboard could not be used');
    } finally {
      if (original) Object.defineProperty(Navigator.prototype, 'clipboard', original);
      delete (navigator as unknown as Record<string, unknown>)['clipboard'];
    }
    flush();
  }));

  it('drops a 201 that lands AFTER the screen was left, parking the code nowhere', fakeAsync(async () => {
    // The only home a credential has is this component's transient state. A response
    // that outlives it has nowhere to go, and is dropped rather than stored somewhere
    // that survives navigation. The restaurant exists; its workspace repairs the lost
    // code by reissuing.
    const pending = new Subject<RestaurantCreationResult>();
    api.createAnswer = () => pending;
    await open();
    fillEverything();
    submit();

    await harness.navigateByUrl('/restaurants', LandingStub);
    harness.detectChanges();

    pending.next(created());
    pending.complete();
    harness.detectChanges();

    expect(TestBed.inject(Router).url).toBe('/restaurants');
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        expect(storage.getItem(storage.key(i)!) ?? '').not.toContain(TOKEN);
      }
    }
    expect((harness.routeDebugElement?.nativeElement as HTMLElement).innerHTML).not.toContain(TOKEN);
    flush();
  }));

  // ── CONFLICTS ────────────────────────────────────────────────────────────────────

  function conflict(code: string, message: string, details?: Record<string, string>): WireError {
    return new WireError(409, { status: 409, message, code, ...(details ? { details } : {}) });
  }

  it('shows a phone collision with the account id, and REUSES NOTHING on its own', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(() =>
        conflict(
          'owner_account_already_exists',
          'An account already uses that phone number. Review it and, if it is the intended owner, create the restaurant with that account instead.',
          { owner_user_id: EXISTING_OWNER_ID },
        ),
      );
    await open();
    fillEverything();

    submit();

    expect(api.creations.length).toBe(1);
    const panel = el().querySelector('[data-create-conflict]')!;
    expect(panel.getAttribute('role')).toBe('alert');
    expect(panel.textContent).toContain('Not created');
    expect(el().querySelector('[data-create-conflict-message]')?.textContent?.trim()).toBe(
      'An account already uses that phone number. Review it and, if it is the intended owner, create the restaurant with that account instead.',
    );
    expect(el().querySelector('[data-create-conflict-owner-id]')?.textContent?.trim()).toBe(EXISTING_OWNER_ID);
    expect(panel.textContent).toContain('Nothing was reused automatically');
    // The form is still the operator's draft; the mode has NOT been switched for them.
    expect(field('data-create-owner-new').checked).toBeTrue();
    expect(el().querySelector('[data-create-owner-existing-fields]')).toBeNull();
    expect(status.unavailable()).toBeFalse();
    flush();
  }));

  it('offers ONE deliberate step to the existing account, and does not submit it', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(() =>
        conflict('owner_account_already_exists', 'An account already uses that phone number.', {
          owner_user_id: EXISTING_OWNER_ID,
        }),
      );
    await open();
    fillEverything();
    submit();

    el().querySelector<HTMLButtonElement>('[data-create-use-existing] button')!.click();
    harness.detectChanges();

    expect(api.creations.length).withContext('switching modes sends nothing').toBe(1);
    expect(field('data-create-owner-existing').checked).toBeTrue();
    expect(field('data-create-user-id').value).toBe(EXISTING_OWNER_ID);
    expect(el().querySelector('[data-create-conflict]')).toBeNull();

    // The operator reviews and creates again — and the body is now the existing-owner
    // contract, with the new-owner draft unrepresentable on the wire.
    api.createAnswer = () => of(created({ owner_account: { id: EXISTING_OWNER_ID, created: false } }));
    submit();
    expect(api.creations.length).toBe(2);
    expect(api.creations[1].owner).toEqual({ mode: 'existing', user_id: EXISTING_OWNER_ID });
    expect(text()).toContain('An existing owner account was attached');
    flush();
  }));

  it('names NO account for an email collision, and offers no switch', fakeAsync(async () => {
    // Email is not identity. The server deliberately returns no id here, and a switch
    // would invite exactly the "email identifies the owner" inference it refuses.
    api.createAnswer = () =>
      throwError(() => conflict('owner_email_already_in_use', 'Another account already uses that email address.'));
    await open();
    fillEverything();
    submit();

    expect(el().querySelector('[data-create-conflict-message]')?.textContent?.trim()).toBe(
      'Another account already uses that email address.',
    );
    expect(el().querySelector('[data-create-conflict-owner-id]')).toBeNull();
    expect(el().querySelector('[data-create-use-existing]')).toBeNull();
    flush();
  }));

  it('shows the id for an unknown or deactivated existing account without offering to use it', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(() =>
        conflict('owner_account_inactive', 'That account is deactivated.', {
          owner_user_id: EXISTING_OWNER_ID,
        }),
      );
    await open();
    fillRestaurant();
    choose('data-create-owner-existing');
    type('data-create-user-id', EXISTING_OWNER_ID);
    type('data-create-reason', REASON);
    submit();

    expect(el().querySelector('[data-create-conflict-owner-id]')?.textContent?.trim()).toBe(EXISTING_OWNER_ID);
    expect(el().querySelector('[data-create-use-existing]')).toBeNull();
    expect(text()).not.toContain('Reactivat');
    flush();
  }));

  it('points a duplicate restaurant at the EXISTING one, where a lost code is reissued', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(() =>
        conflict('restaurant_already_exists', 'A restaurant with that name and location already exists.', {
          restaurant_id: CREATED_ID,
        }),
      );
    await open();
    fillEverything();
    submit();

    expect(el().querySelector('[data-create-conflict-message]')?.textContent?.trim()).toBe(
      'A restaurant with that name and location already exists.',
    );
    const existing = el().querySelector<HTMLAnchorElement>('[data-create-open-existing]')!;
    expect(existing.getAttribute('href')).toBe(`/restaurants/${CREATED_ID}/readiness`);
    expect(text()).toContain('reissue the claim code from its Readiness tab');
    flush();
  }));

  // ── VALIDATION ───────────────────────────────────────────────────────────────────

  it('keeps the form and the draft on a 400, with each error beside the field it names', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(
        () =>
          new WireError(400, {
            status: 400,
            message: 'The restaurant could not be created.',
            code: 'invalid_owner_phone',
            errors: {
              owner: { phone_number: ['Cannot canonicalise phone number (7 digits).'] },
              reason: ['Please state a reason of at least 10 characters.'],
            },
          }),
      );
    await open();
    fillEverything();
    submit();

    expect(el().querySelector('form')).toBeTruthy();
    expect(field('data-create-phone').value).toBe('0772140388');
    const phoneErrors = Array.from(
      field('data-create-phone').parentElement!.querySelectorAll('[data-create-field-error]'),
    ).map((node) => node.textContent?.trim());
    expect(phoneErrors).toEqual(['Cannot canonicalise phone number (7 digits).']);
    const reasonErrors = Array.from(el().querySelectorAll('[data-create-field-error]')).map((node) =>
      node.textContent?.trim(),
    );
    expect(reasonErrors).toContain('Please state a reason of at least 10 characters.');
    expect(el().querySelector('[data-create-error]')?.textContent?.trim()).toBe(
      'The restaurant could not be created.',
    );
    flush();
  }));

  it('shows a 400 the form has no field for, rather than refusing silently', fakeAsync(async () => {
    api.createAnswer = () =>
      throwError(
        () =>
          new WireError(400, {
            status: 400,
            message: 'The restaurant could not be created.',
            errors: { __all__: ['Something about the whole request.'] },
          }),
      );
    await open();
    fillEverything();
    submit();

    expect(text()).toContain('Something about the whole request.');
    flush();
  }));

  // ── RE-AUTHENTICATION AND THE INDETERMINATE OUTCOME ──────────────────────────────

  it('preserves the whole draft when re-authentication is cancelled', fakeAsync(async () => {
    api.createAnswer = () => throwError(() => new ElevationCancelledError());
    await open();
    fillEverything();
    submit();

    expect(el().querySelector('[data-create-error]')?.textContent?.trim()).toBe(
      'Re-authentication was cancelled. Nothing was created.',
    );
    expect(field('data-create-name').value).toBe('Speke Road Cafe');
    expect(field('data-create-phone').value).toBe('0772140388');
    expect(field<HTMLTextAreaElement>('data-create-reason').value).toBe(REASON);
    expect(submitButton().disabled).toBeFalse();
    flush();
  }));

  for (const [label, error] of [
    ['a dead socket', { status: 0, error: null, message: 'Http failure response' }],
    ['a 502', new WireError(502, '<html>Bad Gateway</html>')],
  ] as const) {
    it(`treats ${label} as INDETERMINATE: no "failed", no retry, and the directory first`, fakeAsync(async () => {
      api.createAnswer = () => throwError(() => error);
      await open();
      fillEverything();
      submit();

      expect(api.creations.length).toBe(1);
      const panel = el().querySelector('[data-create-indeterminate]')!;
      expect(panel).toBeTruthy();
      expect(panel.getAttribute('role')).toBe('alert');
      expect(panel.textContent).toContain('Outcome unknown');
      expect(panel.textContent).toContain('not known whether the restaurant was created');
      expect(panel.textContent).toContain('Nothing was retried automatically');
      expect(panel.textContent).toContain('reissue the claim code from its Readiness tab');
      expect(text().toLowerCase()).not.toContain('failed');
      expect(status.unavailable()).toBeTrue();

      // The way to find out points at the directory, pre-filtered on the name typed.
      const look = el().querySelector<HTMLAnchorElement>('[data-create-look-in-directory]')!;
      expect(look.getAttribute('href')).toBe('/restaurants?search=Speke%20Road%20Cafe');

      // The draft survives for a DELIBERATE decision, and nothing is resent meanwhile.
      expect(field('data-create-name').value).toBe('Speke Road Cafe');
      expect(submitButton().disabled).toBeFalse();
      tick(60_000);
      expect(api.creations.length).toBe(1);
      flush();
    }));
  }

  it('carries the request id of an answer that did reach a server', fakeAsync(async () => {
    api.createAnswer = () => throwError(() => new WireError(503, null));
    await open();
    fillEverything();
    submit();

    expect(status.requestId()).toBe(REQUEST_ID);
    flush();
  }));

  it('never uses delivery vocabulary on the form either', fakeAsync(async () => {
    await open();
    expect(text()).not.toMatch(/\b(sent|resend|resent|delivered|delivery failed|SMS|emailed)\b/i);
    expect(text()).not.toContain('Send invitation');
    expect(text()).toContain('hand it to the owner yourself');
    flush();
  }));
});
