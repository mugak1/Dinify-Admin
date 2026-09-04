import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of } from 'rxjs';

import { RESTAURANT_API, RestaurantApi } from './restaurant.api';
import { RestaurantWorkspaceStore } from './restaurant-workspace.store';
import { OnboardingSummary, RestaurantDetail } from './restaurant.model';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function onboarding(overrides: Partial<OnboardingSummary> = {}): OnboardingSummary {
  return {
    tracked: true,
    source: 'admin_created',
    recorded_at: '2026-08-22T09:14:33+03:00',
    owner_relationship: { status: 'consistent' },
    owner_control: { status: 'not_established', evidence: null, evidence_at: null },
    invitation: {
      status: 'pending',
      id: '4d5e6f70-8192-4a3b-9c4d-000000000001',
      issued_at: '2026-08-20T10:00:00+03:00',
      expires_at: '2026-08-27T10:00:00+03:00',
    },
    ...overrides,
  };
}

function detail(overrides: Partial<RestaurantDetail> = {}): RestaurantDetail {
  return {
    id: ID,
    name: 'Ankole Grill House',
    location: 'Kololo, Kampala',
    status: 'onboarding',
    is_test: false,
    readiness: { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'] },
    commercial: {
      payment_timing: { configured: true, value: 'pay_first', set_at: '2026-08-20T09:30:00+03:00' },
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
    last_activity_at: null,
    needs_attention: true,
    allowed_transitions: ['live', 'offboarded'],
    created_at: '2026-05-02T08:00:00+03:00',
    owner: {
      id: '00000000-0000-4000-8000-000000000009',
      name: 'Miriam Nakato',
      email: 'miriam@ankolegrill.ug',
      phone_number: '256772140388',
      is_active: true,
      claim_tracked: true,
      claim_status: 'not_established',
    },
    onboarding: onboarding(),
    support: { open_issue_count: 0 },
    operations: { table_count: 0, usable_table_count: 0, dining_area_count: 0, latest_order: null },
    recent_activity: [],
    ...overrides,
  };
}

class StubApi implements RestaurantApi {
  answer: (id: string) => Observable<RestaurantDetail> = () => of(detail());
  detailCalls = 0;

  detail(id: string): Observable<RestaurantDetail> {
    this.detailCalls += 1;
    return this.answer(id);
  }
  list(): Observable<never> {
    throw new Error('not used');
  }
  setPaymentTiming(): Observable<never> {
    throw new Error('not used');
  }
  setPaymentCollectionMode(): Observable<never> {
    throw new Error('not used');
  }
  recordSubscriptionTerms(): Observable<never> {
    throw new Error('not used');
  }
  replaceSubscriptionTerms(): Observable<never> {
    throw new Error('not used');
  }
  endSubscriptionTerms(): Observable<never> {
    throw new Error('not used');
  }
  createRestaurant(): Observable<never> {
    throw new Error('not used');
  }
  reissueOwnerInvitation(): Observable<never> {
    throw new Error('not used');
  }
  cancelOwnerInvitation(): Observable<never> {
    throw new Error('not used');
  }
}

/** Everything on a detail EXCEPT the two fields an onboarding adoption is allowed to touch. */
function withoutOnboardingAndOwner(record: RestaurantDetail): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...record };
  delete copy['onboarding'];
  delete copy['owner'];
  return copy;
}

/**
 * THE WORKSPACE STORE'S TWO WRITE SLOTS AND ITS TWO ADOPTIONS (Step 2G).
 *
 * The screens' specs prove the behaviour end to end; these pin the store's own
 * contract, which the screens rely on and which is easy to change by accident: the
 * invitation slot is SEPARATE from the commercial one, an adoption replaces exactly the
 * projection it was handed, and a superseded projection stays flagged until the fresh
 * read has settled.
 */
describe('RestaurantWorkspaceStore', () => {
  let store: RestaurantWorkspaceStore;
  let api: StubApi;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({
      providers: [RestaurantWorkspaceStore, { provide: RESTAURANT_API, useValue: api }],
    });
    store = TestBed.inject(RestaurantWorkspaceStore);
  });

  describe('the invitation write slot', () => {
    it('is ONE at a time, and is not the commercial slot', () => {
      // An invitation write returns the canonical `onboarding` object and touches
      // `commercial` not at all, so the two domains cannot repaint each other. Sharing
      // one slot would shut the Readiness controls while a terms write ran on Overview,
      // for a reason that does not exist.
      expect(store.beginInvitationMutation()).toBeTrue();
      expect(store.invitationMutating()).toBeTrue();
      expect(store.mutating()).withContext('the commercial slot is untouched').toBeFalse();
      expect(store.beginInvitationMutation()).withContext('a second claim is refused').toBeFalse();

      expect(store.beginMutation()).withContext('a commercial write may still start').toBeTrue();
      expect(store.mutating()).toBeTrue();

      store.endInvitationMutation();
      expect(store.invitationMutating()).toBeFalse();
      expect(store.mutating()).withContext('releasing one slot leaves the other held').toBeTrue();
      store.endMutation();
      expect(store.mutating()).toBeFalse();
    });

    it('can be released with nothing loaded — the tab that claimed it may be gone', () => {
      store.beginInvitationMutation();
      expect(() => store.endInvitationMutation()).not.toThrow();
      expect(store.invitationMutating()).toBeFalse();
    });
  });

  describe('adoptOnboarding', () => {
    it('replaces ONLY the onboarding projection, and re-derives the owner aliases from it', () => {
      store.load(ID);
      const before = store.detail()!;

      const next = onboarding({
        owner_control: {
          status: 'invitation_redeemed',
          evidence: 'invitation_redeemed',
          evidence_at: '2026-08-26T08:00:00+03:00',
        },
        invitation: {
          status: 'consumed',
          id: '4d5e6f70-8192-4a3b-9c4d-000000000001',
          issued_at: '2026-08-20T10:00:00+03:00',
          expires_at: '2026-08-27T10:00:00+03:00',
        },
      });
      store.adoptOnboarding(next);

      const after = store.detail()!;
      expect(after.onboarding).toEqual(next);
      // The backend's own rule for the compatibility aliases: `tracked`, and the
      // owner-control status while tracked. Two answers to one question must agree.
      expect(after.owner?.claim_tracked).toBeTrue();
      expect(after.owner?.claim_status).toBe('invitation_redeemed');
      // Nothing else moved — not the commercial projection, not the owner's identity.
      expect(after.commercial).toEqual(before.commercial);
      expect(after.owner?.name).toBe(before.owner?.name);
      expect(after.owner?.phone_number).toBe(before.owner?.phone_number);
      expect(withoutOnboardingAndOwner(after)).toEqual(withoutOnboardingAndOwner(before));
      expect(api.detailCalls).withContext('adopted, not refetched').toBe(1);
    });

    it('nulls the claim_status alias for an untracked projection, and copes with no owner row', () => {
      api.answer = () => of(detail({ owner: null }));
      store.load(ID);

      store.adoptOnboarding({
        tracked: false,
        source: null,
        recorded_at: null,
        owner_relationship: { status: 'unavailable' },
        owner_control: { status: 'unavailable', evidence: null, evidence_at: null },
        invitation: { status: 'unavailable', id: null, issued_at: null, expires_at: null },
      });

      expect(store.detail()?.owner).toBeNull();
      expect(store.detail()?.onboarding.tracked).toBeFalse();
    });

    it('is a no-op with nothing loaded — there is no detail to attach a projection to', () => {
      store.adoptOnboarding(onboarding());
      expect(store.detail()).toBeNull();
    });
  });

  describe('reloadSuperseded', () => {
    it('flags the projection superseded until the fresh read SETTLES, keeping the old detail meanwhile', () => {
      store.load(ID);
      expect(store.detailSuperseded()).toBeFalse();

      const reload = new Subject<RestaurantDetail>();
      api.answer = () => reload;
      store.reloadSuperseded();

      expect(store.detailSuperseded()).toBeTrue();
      expect(store.loading()).toBeTrue();
      expect(store.detail()).withContext('the previous detail stays in place').not.toBeNull();

      reload.next(detail({ onboarding: onboarding({ invitation: { status: 'cancelled', id: 'x', issued_at: null, expires_at: null } }) }));
      reload.complete();

      expect(store.detailSuperseded()).toBeFalse();
      expect(store.detail()?.onboarding.invitation.status).toBe('cancelled');
    });

    it('is what an ordinary reload deliberately does NOT do', () => {
      store.load(ID);
      const reload = new Subject<RestaurantDetail>();
      api.answer = () => reload;

      store.reload();

      expect(store.loading()).toBeTrue();
      expect(store.detailSuperseded()).withContext('a retry is not a known-wrong projection').toBeFalse();
      reload.complete();
    });
  });
});
