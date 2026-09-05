import { fakeAsync, tick } from '@angular/core/testing';
import { Observable } from 'rxjs';

import {
  CreateRestaurantRequest,
  OwnerInvitationRequest,
  RestaurantCreationResult,
  RestaurantDetail,
  RestaurantDirectoryPage,
} from '../core/restaurants/restaurant.model';
import { MockHttpError } from './mock-http-error';
import { MockRestaurantApi } from './mock-restaurant-api';
import { MOCK_RESTAURANT_DETAILS } from './mock-restaurants.fixtures';

/** Longer than the mock's latency, so every answer has landed. */
const SETTLE_MS = 500;
const REASON = 'Signed pilot agreement, March cohort';
/** `secrets.token_urlsafe(48)`: 64 base64url characters. */
const CLAIM_CODE = /^[A-Za-z0-9_-]{64}$/;

/** Resolve one mocked call inside `fakeAsync`, as a value or as the error it threw. */
function settle<T>(source: Observable<T>): { value?: T; error?: MockHttpError } {
  const outcome: { value?: T; error?: MockHttpError } = {};
  source.subscribe({
    next: (value) => (outcome.value = value),
    error: (error: MockHttpError) => (outcome.error = error),
  });
  tick(SETTLE_MS);
  return outcome;
}

function body(error: MockHttpError | undefined): Record<string, unknown> {
  return (error?.error ?? {}) as Record<string, unknown>;
}

function byName(name: string): RestaurantDetail {
  const found = [...MOCK_RESTAURANT_DETAILS.values()].find((record) => record.name === name);
  if (!found) throw new Error(`no fixture named ${name}`);
  return found;
}

function newOwnerRequest(overrides: Partial<CreateRestaurantRequest> = {}): CreateRestaurantRequest {
  return {
    restaurant: { name: 'Speke Road Bakery', location: 'Kampala', is_test: false },
    owner: {
      mode: 'new',
      first_name: 'grace',
      last_name: 'ATIM',
      phone_number: '0700 111 222',
      email: null,
    },
    reason: REASON,
    ...overrides,
  };
}

function invitationRequest(expectedId: string | null): OwnerInvitationRequest {
  return { expected_invitation_id: expectedId as string, reason: REASON };
}

/**
 * THE MOCK TRANSPORT'S CREATION AND INVITATION CONTRACT (Step 2G) — development only,
 * but reviewed as if it were the server, because `npm start` is where this work is
 * reviewed before a deploy carries it.
 *
 * What these hold: the mock applies the server's own rules in the server's own order,
 * mints a fresh claim code per response and KEEPS NONE OF THEM, treats a collision as a
 * refusal and never a reuse, and reproduces the two outcomes no real input can — a
 * concurrency conflict, and a commit whose answer was lost.
 */
describe('MockRestaurantApi — creation and owner invitation', () => {
  let api: MockRestaurantApi;
  let warn: jasmine.Spy;

  beforeEach(() => {
    sessionStorage.clear();
    warn = spyOn(console, 'warn');
    api = new MockRestaurantApi();
  });

  afterEach(() => sessionStorage.clear());

  it('announces itself through the build marker, which is what the isolation gate scans for', () => {
    expect(warn).toHaveBeenCalledWith(jasmine.stringMatching('DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT'));
  });

  // ── CREATION ─────────────────────────────────────────────────────────────────────

  describe('createRestaurant', () => {
    it('creates the six-row state and answers with the canonical detail and a one-time code', fakeAsync(() => {
      const { value } = settle(api.createRestaurant(newOwnerRequest()));

      expect(value).toBeDefined();
      const result = value as RestaurantCreationResult;
      expect(result.owner_account.created).toBeTrue();
      expect(result.owner_invitation.claim_token).toMatch(CLAIM_CODE);
      expect(result.owner_invitation.id).toBe(result.restaurant.onboarding.invitation.id as string);

      const record = result.restaurant;
      expect(record.status).toBe('onboarding');
      expect(record.is_test).toBeFalse();
      expect(record.readiness).toEqual({
        state: 'not_ready',
        blocker_count: 1,
        blockers: ['readiness_not_configured'],
      });
      expect(record.needs_attention).toBeTrue();
      expect(record.onboarding.source).toBe('admin_created');
      expect(record.onboarding.owner_relationship.status).toBe('consistent');
      // CREATION DOES NOT ESTABLISH OWNER CONTROL.
      expect(record.onboarding.owner_control.status).toBe('not_established');
      expect(record.onboarding.invitation.status).toBe('pending');
      // `.strip().title()`, and the canonical MSISDN.
      expect(record.owner?.name).toBe('Grace Atim');
      expect(record.owner?.phone_number).toBe('256700111222');
      expect(record.owner?.claim_status).toBe('not_established');
      expect(record.commercial.subscription_terms.configured).toBeFalse();
      expect(record.recent_activity.map((entry) => entry.action)).toEqual(['admin.restaurant.created']);
    }));

    it('mints a DIFFERENT code per creation and keeps none of them anywhere it could be read back', fakeAsync(() => {
      const first = settle(api.createRestaurant(newOwnerRequest())).value!;
      const second = settle(
        api.createRestaurant(
          newOwnerRequest({
            restaurant: { name: 'Second Bakery', location: 'Jinja', is_test: true },
            owner: { mode: 'new', first_name: 'A', last_name: 'B', phone_number: '0700333444', email: null },
          }),
        ),
      ).value!;

      expect(first.owner_invitation.claim_token).not.toBe(second.owner_invitation.claim_token);

      // The read path — detail AND directory — carries the projection and never the code.
      const detail = settle(api.detail(first.restaurant.id)).value!;
      expect(detail.onboarding.invitation.id).toBe(first.owner_invitation.id);
      expect(JSON.stringify(detail)).not.toContain(first.owner_invitation.claim_token);
      const page = settle(
        api.list({ search: 'Speke Road Bakery', status: null, attention: null, page: 1, pageSize: null }),
      ).value as RestaurantDirectoryPage;
      expect(page.results.map((row) => row.name)).toEqual(['Speke Road Bakery']);
      expect(JSON.stringify(page)).not.toContain(first.owner_invitation.claim_token);
      // And the row is a ROW: no onboarding, owner or activity leaks into the directory.
      expect('onboarding' in page.results[0]).toBeFalse();
      expect('owner' in page.results[0]).toBeFalse();
      expect(second.restaurant.is_test).toBeTrue();
    }));

    it('refuses a phone already in use as a 409 naming the account — canonicalised first', fakeAsync(() => {
      // Ankole Grill House's owner is 256772140388; typed with a trunk zero and spaces it
      // is the same number, and the same refusal. The body names the account's UUID and
      // NOTHING else about it.
      const ankole = byName('Ankole Grill House');
      const { value, error } = settle(
        api.createRestaurant(
          newOwnerRequest({
            owner: { mode: 'new', first_name: 'X', last_name: 'Y', phone_number: '0772 140 388', email: null },
          }),
        ),
      );

      expect(value).toBeUndefined();
      expect(error?.status).toBe(409);
      expect(body(error)['code']).toBe('owner_account_already_exists');
      expect(body(error)['details']).toEqual({ owner_user_id: ankole.owner!.id });
      expect(JSON.stringify(body(error))).not.toContain(ankole.owner!.name as string);
      expect(JSON.stringify(body(error))).not.toContain('256772140388');
    }));

    it('refuses an email already in use WITHOUT naming an account', fakeAsync(() => {
      const { error } = settle(
        api.createRestaurant(
          newOwnerRequest({
            owner: {
              mode: 'new',
              first_name: 'X',
              last_name: 'Y',
              phone_number: '0700999888',
              email: 'MIRIAM@ankolegrill.ug',
            },
          }),
        ),
      );

      expect(error?.status).toBe(409);
      expect(body(error)['code']).toBe('owner_email_already_in_use');
      expect(body(error)['details']).toBeUndefined();
    }));

    it('attaches an existing ACTIVE account unmodified, and refuses an unknown or deactivated one', fakeAsync(() => {
      const bistro = byName('Kampala Bistro');
      const attached = settle(
        api.createRestaurant(
          newOwnerRequest({
            restaurant: { name: 'Bistro Second Site', location: 'Entebbe', is_test: false },
            owner: { mode: 'existing', user_id: bistro.owner!.id.toUpperCase() },
          }),
        ),
      ).value!;
      expect(attached.owner_account).toEqual({ id: bistro.owner!.id, created: false });
      expect(attached.restaurant.owner?.name).toBe(bistro.owner!.name);

      const unknown = settle(
        api.createRestaurant(
          newOwnerRequest({ owner: { mode: 'existing', user_id: '1f2e3d4c-5b6a-4978-8899-ffffffffffff' } }),
        ),
      );
      expect(unknown.error?.status).toBe(409);
      expect(body(unknown.error)['code']).toBe('owner_account_not_found');

      const nilePerch = byName('Nile Perch House');
      const inactive = settle(
        api.createRestaurant(newOwnerRequest({ owner: { mode: 'existing', user_id: nilePerch.owner!.id } })),
      );
      expect(inactive.error?.status).toBe(409);
      expect(body(inactive.error)['code']).toBe('owner_account_inactive');
      expect(body(inactive.error)['details']).toEqual({ owner_user_id: nilePerch.owner!.id });
    }));

    it('refuses a duplicate name and location, case-insensitively, naming the existing restaurant', fakeAsync(() => {
      const ankole = byName('Ankole Grill House');
      const { error } = settle(
        api.createRestaurant(
          newOwnerRequest({ restaurant: { name: 'ankole grill house', location: 'KOLOLO, kampala', is_test: false } }),
        ),
      );

      expect(error?.status).toBe(409);
      expect(body(error)['code']).toBe('restaurant_already_exists');
      expect(body(error)['details']).toEqual({ restaurant_id: ankole.id });
    }));

    it('refuses a non-boolean is_test and a cross-mode key, nested the way DRF nests them', fakeAsync(() => {
      const request = newOwnerRequest();
      const malformed = {
        restaurant: { ...request.restaurant, is_test: 'false' },
        owner: { ...request.owner, user_id: '' },
        reason: 'short',
      } as unknown as CreateRestaurantRequest;

      const { error } = settle(api.createRestaurant(malformed));

      expect(error?.status).toBe(400);
      expect(body(error)['errors']).toEqual({
        restaurant: { is_test: ['Send true or false.'] },
        owner: { user_id: ['This field is not accepted when mode is "new".'] },
        reason: ['Please state a reason of at least 10 characters.'],
      });
    }));

    it('refuses a phone it cannot canonicalise as a DOMAIN 400 on the field', fakeAsync(() => {
      const { error } = settle(
        api.createRestaurant(
          newOwnerRequest({
            owner: { mode: 'new', first_name: 'X', last_name: 'Y', phone_number: '12345', email: null },
          }),
        ),
      );

      expect(error?.status).toBe(400);
      expect(body(error)['code']).toBe('invalid_owner_phone');
      expect(body(error)['errors']).toEqual({
        owner: { phone_number: ['Cannot canonicalise phone number (5 digits).'] },
      });
    }));

    it("'lost' commits and then loses the answer; 'down' commits nothing", fakeAsync(() => {
      sessionStorage.setItem('dinify-admin.mock-create', 'lost');
      const lost = settle(api.createRestaurant(newOwnerRequest()));
      expect(lost.value).toBeUndefined();
      expect(lost.error?.status).toBe(500);
      expect(sessionStorage.getItem('dinify-admin.mock-create')).withContext('consumed').toBeNull();
      // THE RESTAURANT EXISTS, with a pending invitation whose code nobody has seen.
      const page = settle(
        api.list({ search: 'Speke Road Bakery', status: null, attention: null, page: 1, pageSize: null }),
      ).value as RestaurantDirectoryPage;
      expect(page.results.length).toBe(1);
      const detail = settle(api.detail(page.results[0].id)).value!;
      expect(detail.onboarding.invitation.status).toBe('pending');

      sessionStorage.setItem('dinify-admin.mock-create', 'down');
      const down = settle(
        api.createRestaurant(
          newOwnerRequest({
            restaurant: { name: 'Never Made', location: 'Nowhere', is_test: false },
            owner: { mode: 'new', first_name: 'A', last_name: 'B', phone_number: '0700555666', email: null },
          }),
        ),
      );
      expect(down.error?.status).toBe(500);
      const none = settle(
        api.list({ search: 'Never Made', status: null, attention: null, page: 1, pageSize: null }),
      ).value as RestaurantDirectoryPage;
      expect(none.results.length).toBe(0);
    }));
  });

  // ── REISSUE AND CANCEL ───────────────────────────────────────────────────────────

  describe('reissueOwnerInvitation and cancelOwnerInvitation', () => {
    it('reissue supersedes the head with a NEW pending credential, and the old id goes stale', fakeAsync(() => {
      const speke = byName('Speke Road Cafe');
      const head = speke.onboarding.invitation.id as string;
      expect(speke.onboarding.invitation.status).toBe('pending');

      const { value } = settle(api.reissueOwnerInvitation(speke.id, invitationRequest(head)));

      expect(value?.changed).toBeTrue();
      expect(value?.owner_invitation.claim_token).toMatch(CLAIM_CODE);
      expect(value?.owner_invitation.id).not.toBe(head);
      expect(value?.onboarding.invitation).toEqual(
        jasmine.objectContaining({ status: 'pending', id: value?.owner_invitation.id }),
      );
      // ISSUANCE IS NOT CONTROL: the owner-control axis did not move.
      expect(value?.onboarding.owner_control.status).toBe('not_established');
      // The read now presents the new head, and never the code.
      const after = settle(api.detail(speke.id)).value!;
      expect(after.onboarding.invitation.id).toBe(value!.owner_invitation.id);
      expect(JSON.stringify(after)).not.toContain(value!.owner_invitation.claim_token);
      // A write still naming the old head is a conflict, never an overwrite.
      const stale = settle(api.cancelOwnerInvitation(speke.id, invitationRequest(head)));
      expect(stale.error?.status).toBe(409);
      expect(body(stale.error)['code']).toBe('stale_owner_invitation');
      expect(body(stale.error)['details']).toBeUndefined();
    }));

    it('cancel stamps the exact head; an exact retry is changed:false; a resolved head is refused', fakeAsync(() => {
      const speke = byName('Speke Road Cafe');
      const head = speke.onboarding.invitation.id as string;

      const first = settle(api.cancelOwnerInvitation(speke.id, invitationRequest(head))).value!;
      expect(first.changed).toBeTrue();
      expect(first.onboarding.invitation).toEqual(jasmine.objectContaining({ status: 'cancelled', id: head }));

      const again = settle(api.cancelOwnerInvitation(speke.id, invitationRequest(head))).value!;
      expect(again.changed).toBeFalse();

      // Reissue out of cancelled mints beside it; the cancelled row is history.
      const reissued = settle(api.reissueOwnerInvitation(speke.id, invitationRequest(head))).value!;
      expect(reissued.onboarding.invitation.status).toBe('pending');
      expect(reissued.onboarding.invitation.id).not.toBe(head);

      const kampala = byName('Kampala Bistro');
      const consumed = settle(
        api.cancelOwnerInvitation(kampala.id, invitationRequest(kampala.onboarding.invitation.id)),
      );
      expect(consumed.error?.status).toBe(409);
      expect(body(consumed.error)['code']).toBe('owner_invitation_already_resolved');
    }));

    it('refuses what the server refuses, with the server’s codes', fakeAsync(() => {
      const ankole = byName('Ankole Grill House');
      const legacy = settle(api.reissueOwnerInvitation(ankole.id, invitationRequest('4d5e6f70-8192-4a3b-9c4d-000000000000')));
      expect(body(legacy.error)['code']).toBe('owner_invitation_not_applicable');

      const entebbe = byName('Entebbe Lakeside Kitchen');
      const untracked = settle(api.cancelOwnerInvitation(entebbe.id, invitationRequest('4d5e6f70-8192-4a3b-9c4d-000000000000')));
      expect(body(untracked.error)['code']).toBe('onboarding_not_tracked');

      const bugolobi = byName('Bugolobi Shawarma Bar');
      const notIssued = settle(api.reissueOwnerInvitation(bugolobi.id, invitationRequest('4d5e6f70-8192-4a3b-9c4d-000000000000')));
      expect(body(notIssued.error)['code']).toBe('owner_invitation_not_issued');

      const kampala = byName('Kampala Bistro');
      const claimed = settle(api.reissueOwnerInvitation(kampala.id, invitationRequest(kampala.onboarding.invitation.id)));
      expect(body(claimed.error)['code']).toBe('owner_control_already_established');

      const mbarara = byName('Mbarara Steakhouse');
      const drifted = settle(api.reissueOwnerInvitation(mbarara.id, invitationRequest(mbarara.onboarding.invitation.id)));
      expect(body(drifted.error)['code']).toBe('owner_membership_mismatch');
      // Cancellation deliberately does NOT require owner consistency.
      const withdrawn = settle(api.cancelOwnerInvitation(mbarara.id, invitationRequest(mbarara.onboarding.invitation.id)));
      expect(withdrawn.value?.changed).toBeTrue();

      const deactivated = [...MOCK_RESTAURANT_DETAILS.values()].find(
        (record) => record.onboarding.invitation.status === 'pending' && record.owner?.is_active === false,
      )!;
      const inactive = settle(api.reissueOwnerInvitation(deactivated.id, invitationRequest(deactivated.onboarding.invitation.id)));
      expect(body(inactive.error)['code']).toBe('owner_account_inactive');

      const malformed = settle(api.reissueOwnerInvitation(kampala.id, { expected_invitation_id: 42 as unknown as string, reason: REASON }));
      expect(malformed.error?.status).toBe(400);
      expect(body(malformed.error)['errors']).toEqual({
        expected_invitation_id: ['Send the invitation id as a UUID string.'],
      });

      const missing = settle(api.cancelOwnerInvitation('9a7f1cf0-4b2e-4f3a-9c1d-fffffffffff0', invitationRequest(kampala.onboarding.invitation.id)));
      expect(missing.error?.status).toBe(404);
    }));

    it('the levers fire ONCE, never override a no-op, and "lost" leaves a head nobody has seen', fakeAsync(() => {
      const speke = byName('Speke Road Cafe');
      const head = speke.onboarding.invitation.id as string;

      sessionStorage.setItem('dinify-admin.mock-invitation', 'stale');
      const stale = settle(api.reissueOwnerInvitation(speke.id, invitationRequest(head)));
      expect(body(stale.error)['code']).toBe('stale_owner_invitation');
      expect(sessionStorage.getItem('dinify-admin.mock-invitation')).toBeNull();
      expect(settle(api.detail(speke.id)).value?.onboarding.invitation.id).withContext('nothing moved').toBe(head);

      sessionStorage.setItem('dinify-admin.mock-invitation', 'lost');
      const lost = settle(api.reissueOwnerInvitation(speke.id, invitationRequest(head)));
      expect(lost.error?.status).toBe(500);
      const moved = settle(api.detail(speke.id)).value!;
      expect(moved.onboarding.invitation.status).toBe('pending');
      expect(moved.onboarding.invitation.id).withContext('rotated, and the code was never delivered').not.toBe(head);

      sessionStorage.setItem('dinify-admin.mock-invitation', 'down');
      const down = settle(api.cancelOwnerInvitation(speke.id, invitationRequest(moved.onboarding.invitation.id)));
      expect(down.error?.status).toBe(500);
      expect(settle(api.detail(speke.id)).value?.onboarding.invitation.status).toBe('pending');

      // A no-op is a no-op whatever the lever says.
      settle(api.cancelOwnerInvitation(speke.id, invitationRequest(moved.onboarding.invitation.id)));
      sessionStorage.setItem('dinify-admin.mock-invitation', 'stale');
      const retry = settle(api.cancelOwnerInvitation(speke.id, invitationRequest(moved.onboarding.invitation.id)));
      expect(retry.value?.changed).toBeFalse();
      expect(sessionStorage.getItem('dinify-admin.mock-invitation')).withContext('consumed all the same').toBeNull();
    }));
  });
});
