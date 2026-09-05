import * as labelModule from './restaurant.labels';
import {
  activityActionLabel,
  activityResultIsNotable,
  activityResultLabel,
  isNotConfigured,
  lifecycleVariant,
  onboardingSourceLabel,
  onboardingSourceNote,
  ownerControlEvidenceLabel,
  ownerControlIsNotable,
  ownerControlLabel,
  ownerControlNote,
  ownerInvitationIsNotable,
  ownerInvitationLabel,
  ownerInvitationNote,
  ownerRelationshipIsNotable,
  ownerRelationshipLabel,
  ownerRelationshipNote,
  billingIntervalLabel,
  commercialPaymentLabel,
  paymentCollectionModeLabel,
  paymentCollectionModeNote,
  paymentTimingLabel,
  readinessBlockerLabel,
  readinessLabel,
  SUBSCRIPTION_TERMS_NOTE,
  subscriptionMethodLabel,
  subscriptionTermsLabel,
} from './restaurant.labels';
import {
  CommercialSubscriptionTerms,
  CommercialSummary,
  OwnerControlStatus,
  OwnerInvitationStatus,
  OwnerRelationshipStatus,
  PaymentCollectionMode,
  PaymentTiming,
  ReadinessSummary,
  SubscriptionSummary,
} from './restaurant.model';

function readiness(overrides: Partial<ReadinessSummary> = {}): ReadinessSummary {
  return { state: 'not_ready', blocker_count: 1, blockers: ['readiness_not_configured'], ...overrides };
}

function subscription(overrides: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
  return {
    source: 'legacy_restaurant_fields',
    has_commercial_subscription: false,
    legacy_validity_flag: true,
    legacy_expiry_at: null,
    preferred_method: 'per_order',
    ...overrides,
  };
}

/**
 * The canonical commercial projection, built the way the SERVER builds it — each axis's
 * `configured` derived from its value, and `subscription_terms.configured` from whether
 * an open row exists. A builder that let a spec state `configured: true` beside a null
 * value would be testing a payload the backend cannot emit.
 */
function commercial(
  settings: {
    timing?: PaymentTiming;
    collection?: PaymentCollectionMode;
    terms?: Partial<CommercialSubscriptionTerms>;
  } = {},
): CommercialSummary {
  const terms = settings.terms;
  return {
    payment_timing: {
      configured: settings.timing !== undefined,
      value: settings.timing ?? null,
      set_at: settings.timing === undefined ? null : '2026-08-20T12:00:00+03:00',
    },
    payment_collection_mode: {
      configured: settings.collection !== undefined,
      value: settings.collection ?? null,
      set_at: settings.collection === undefined ? null : '2026-08-20T12:00:00+03:00',
    },
    subscription_terms: {
      configured: terms !== undefined,
      current:
        terms === undefined
          ? null
          : {
              id: '5d6e7f80-9a1b-4c2d-8e3f-000000000001',
              recurring_amount: '150000.00',
              currency: 'UGX',
              billing_interval: { unit: 'month', count: 1 },
              effective_from: '2026-08-01T00:00:00+03:00',
              recorded_at: '2026-08-01T00:00:00+03:00',
              ...terms,
            },
    },
  };
}

/**
 * THE RULE THIS FILE ENFORCES: translate, never upgrade.
 *
 * These labels are the single place a backend machine value becomes operator English,
 * which makes them also the single place the portal could start asserting something
 * the database cannot support. A directory column reading "Not configured" looks
 * unfinished, and that is exactly the pressure that produces a screen claiming a
 * subscription is Paid because a legacy boolean happens to be true.
 */
describe('restaurant labels', () => {
  describe('readiness', () => {
    it('reads the fail-closed seam as a statement about the CHECKLIST', () => {
      // `not_ready` + `readiness_not_configured` means Step 3 has not been built. It
      // does NOT mean this restaurant failed a checklist that exists.
      expect(readinessLabel(readiness())).toBe('Not configured');
      expect(isNotConfigured(readiness())).toBeTrue();
    });

    it('reads not_applicable as not applicable, never as ready', () => {
      const summary = readiness({ state: 'not_applicable', blocker_count: 0, blockers: [] });
      expect(readinessLabel(summary)).toBe('Not applicable');
      expect(readinessLabel(summary)).not.toBe('Ready');
    });

    it('reads ready as ready', () => {
      expect(readinessLabel(readiness({ state: 'ready', blocker_count: 0, blockers: [] }))).toBe(
        'Ready',
      );
    });

    it('already counts real blockers, so Step 3 needs no change here', () => {
      expect(
        readinessLabel(readiness({ blocker_count: 3, blockers: ['a', 'b', 'c'] })),
      ).toBe('3 blockers');
      expect(readinessLabel(readiness({ blocker_count: 1, blockers: ['a'] }))).toBe('1 blocker');
      expect(isNotConfigured(readiness({ blocker_count: 1, blockers: ['a'] }))).toBeFalse();
    });

    it('never shows a raw blocker code to an operator', () => {
      expect(readinessBlockerLabel('readiness_not_configured')).toBe(
        'Go-live readiness checks are not configured yet.',
      );
      // An unmapped code — which is what Step 3 produces before this map is updated —
      // is humanised rather than shown raw or dropped.
      expect(readinessBlockerLabel('published_menu_item')).toBe('Published menu item');
      expect(readinessBlockerLabel('')).toBe('');
    });
  });

  describe('payment timing', () => {
    it('names each side of the closed vocabulary', () => {
      expect(paymentTimingLabel('pay_first')).toBe('Pay first');
      expect(paymentTimingLabel('pay_after')).toBe('Pay after');
    });

    it('says not configured for an undecided axis', () => {
      expect(paymentTimingLabel(null)).toBe('Not configured');
    });
  });

  describe('payment collection mode', () => {
    it('names each side of the closed vocabulary', () => {
      expect(paymentCollectionModeLabel('offline')).toBe('Restaurant collects');
      expect(paymentCollectionModeLabel('psp_online')).toBe('Dinify via PSP');
    });

    it('says not configured for an undecided axis', () => {
      expect(paymentCollectionModeLabel(null)).toBe('Not configured');
    });

    it('never describes offline as cash, degraded, manual or pre-launch', () => {
      // `offline` is a PERMANENT, FIRST-CLASS mode: Dinify does not initiate the diner
      // payment and the restaurant collects through whatever tender it likes. Naming one
      // tender misreports every restaurant running its own card machine, and any word
      // implying absence misreports a restaurant fully entitled to go live this way.
      const label = paymentCollectionModeLabel('offline');
      const note = paymentCollectionModeNote('offline') ?? '';
      for (const invented of ['Cash', 'cash', 'Manual', 'Offline only', 'No online payments', 'Degraded', 'Fallback', 'Pre-launch']) {
        expect(label).withContext(`label: ${invented}`).not.toContain(invented);
        expect(note).withContext(`note: ${invented}`).not.toContain(invented);
      }
    });

    it('never claims psp_online means a provider is connected or payments work', () => {
      // The mode records an INTENTION. This platform has no PSP integration, so there is
      // no provider, no merchant id and nothing operational to report.
      const label = paymentCollectionModeLabel('psp_online');
      for (const invented of ['Connected', 'Ready', 'Live', 'Enabled', 'Active']) {
        expect(label).withContext(invented).not.toContain(invented);
      }
      // The note exists precisely to block the stronger read.
      expect(paymentCollectionModeNote('psp_online')).toContain('does not confirm');
    });

    it('has nothing to say about an axis nobody decided', () => {
      expect(paymentCollectionModeNote(null)).toBeNull();
    });
  });

  describe('the combined payment cell', () => {
    it('joins both axes when both are configured', () => {
      expect(commercialPaymentLabel(commercial({ timing: 'pay_first', collection: 'offline' })))
        .toBe('Pay first · Restaurant collects');
    });

    it('KEEPS PARTIAL CONFIGURATION VISIBLE, naming the half that is missing', () => {
      // The whole reason this is one cell rather than a boolean. A restaurant with the
      // service model decided and custody still open is in a real state an operator acts
      // on, and "Configured" would erase it.
      expect(commercialPaymentLabel(commercial({ timing: 'pay_first' })))
        .toBe('Pay first · Collection not configured');
      expect(commercialPaymentLabel(commercial({ collection: 'psp_online' })))
        .toBe('Timing not configured · Dinify via PSP');
    });

    it('says not configured only when NEITHER axis is decided', () => {
      expect(commercialPaymentLabel(commercial())).toBe('Not configured');
    });

    it('distinguishes an absent payload from an unconfigured one', () => {
      // A server that sent no `commercial` object at all has not answered the question.
      // Rendering that as "Not configured" would manufacture a verdict out of a missing
      // payload — the same defect class as a dead backend reading "Invalid credentials."
      expect(commercialPaymentLabel(undefined)).toBe('—');
      expect(commercialPaymentLabel(null)).toBe('—');
    });
  });

  describe('billing interval', () => {
    it('renders a count of one without the numeral', () => {
      expect(billingIntervalLabel({ unit: 'month', count: 1 })).toBe('every month');
      expect(billingIntervalLabel({ unit: 'week', count: 1 })).toBe('every week');
      expect(billingIntervalLabel({ unit: 'year', count: 1 })).toBe('every year');
      expect(billingIntervalLabel({ unit: 'day', count: 1 })).toBe('every day');
    });

    it('PLURALISES a count greater than one', () => {
      // The count is not assumed to be 1. "every 2 month" is the tell that a formatter
      // was written for the common case and never tested on the real vocabulary.
      expect(billingIntervalLabel({ unit: 'month', count: 2 })).toBe('every 2 months');
      expect(billingIntervalLabel({ unit: 'day', count: 14 })).toBe('every 14 days');
      expect(billingIntervalLabel({ unit: 'week', count: 3 })).toBe('every 3 weeks');
      expect(billingIntervalLabel({ unit: 'year', count: 2 })).toBe('every 2 years');
    });

    it('never invents a plan tier', () => {
      // The backend stores a generic recurrence and deliberately not a catalogue. An
      // operator who reads "Basic" will look for a plan definition that does not exist.
      const labels = [
        billingIntervalLabel({ unit: 'month', count: 1 }),
        billingIntervalLabel({ unit: 'year', count: 1 }),
      ];
      for (const label of labels) {
        for (const invented of ['Basic', 'Pro', 'Enterprise', 'Monthly plan', 'Annual plan', 'Trial']) {
          expect(label).withContext(invented).not.toContain(invented);
        }
      }
    });
  });

  describe('subscription terms', () => {
    it('says not configured when no open terms row exists', () => {
      expect(subscriptionTermsLabel(commercial())).toBe('Not configured');
    });

    it('states the recorded price and recurrence, not a status', () => {
      expect(subscriptionTermsLabel(commercial({ terms: {} }))).toBe('UGX 150,000 · every month');
    });

    it('carries a count greater than one into the cell', () => {
      const label = subscriptionTermsLabel(
        commercial({ terms: { recurring_amount: '300000.00', billing_interval: { unit: 'month', count: 2 } } }),
      );
      expect(label).toBe('UGX 300,000 · every 2 months');
    });

    it('renders a ZERO price as a real price, never as free or absent', () => {
      // Zero is a deliberate recorded fact — a waived period, a pilot — and is a
      // DIFFERENT fact from having no terms row. Those two must not read alike.
      const label = subscriptionTermsLabel(commercial({ terms: { recurring_amount: '0.00' } }));
      expect(label).toBe('UGX 0 · every month');
      for (const invented of ['Free', 'Trial', 'Waived', 'No subscription', 'Not configured']) {
        expect(label).withContext(invented).not.toContain(invented);
      }
    });

    it('NEVER ROUNDS A STORED FRACTION AWAY', () => {
      // The amount is a decimal string precisely so no digit is lost between the
      // database and the screen. Deleting one on the way is the portal asserting
      // something tidier than what is stored.
      expect(subscriptionTermsLabel(commercial({ terms: { recurring_amount: '150000.50' } })))
        .toBe('UGX 150,000.50 · every month');
    });

    it('does not assume the currency is UGX', () => {
      // The column has no default and takes any three-letter ISO-4217 code. Relabelling
      // a different currency as shillings is a quiet corruption of a money value.
      expect(
        subscriptionTermsLabel(
          commercial({ terms: { recurring_amount: '4500.75', currency: 'KES' } }),
        ),
      ).toBe('KES 4,500.75 · every month');
    });

    it('distinguishes an absent payload from an unconfigured one', () => {
      expect(subscriptionTermsLabel(undefined)).toBe('—');
      expect(subscriptionTermsLabel(null)).toBe('—');
    });

    it('degrades rather than crashing if configured and current ever disagree', () => {
      // The server keeps them consistent. A client that dereferenced `current` on the
      // strength of the boolean beside it would throw rather than degrade if it stopped.
      const impossible: CommercialSummary = {
        ...commercial(),
        subscription_terms: { configured: true, current: null },
      };
      expect(() => subscriptionTermsLabel(impossible)).not.toThrow();
      expect(subscriptionTermsLabel(impossible)).toBe('Not configured');
    });

    it('NEVER RENDERS OPEN TERMS AS AN ACCOUNT STATUS', () => {
      // THE MOST IMPORTANT ASSERTION IN THIS FILE. It replaced
      // `has_commercial_subscription ? 'Active' : 'Not configured'`. An open terms row
      // means somebody at Dinify wrote down a price — not that an invoice exists, not
      // that anything was collected, not that anyone agreed. There is no invoice model
      // and no collection path on the server at all.
      const label = subscriptionTermsLabel(commercial({ terms: {} }));
      for (const invented of [
        'Active', 'Paid', 'Current', 'Trial', 'In good standing', 'Good standing',
        'Subscribed', 'Billed', 'Collected', 'Agreed', 'Signed',
      ]) {
        expect(label).withContext(invented).not.toContain(invented);
      }
    });

    it('warns in prose that terms are not an invoice or a payment', () => {
      expect(SUBSCRIPTION_TERMS_NOTE).toContain('Recorded terms only');
      expect(SUBSCRIPTION_TERMS_NOTE).toContain('Not an invoice');
    });
  });

  describe('the legacy record', () => {
    it('humanises the legacy billing method, for the fenced-off block only', () => {
      expect(subscriptionMethodLabel('per_order')).toBe('Per order');
      expect(subscriptionMethodLabel(null)).toBe('—');
    });

    it('NO LABEL IN THIS MODULE READS THE LEGACY COMMERCIAL FIELDS ANY MORE', () => {
      // The compatibility fields are frozen on the server — `payment_mode` null,
      // `has_commercial_subscription` false — while `legacy_validity_flag` still varies
      // and defaults TRUE. If any of the three were still an input, a restaurant with
      // canonical state configured would render as unconfigured, and one with nothing
      // configured could render as Active. Both directions are proved at the page level;
      // this pins that the vocabulary layer offers no such function to call.
      const legacy = subscription({ legacy_validity_flag: true, has_commercial_subscription: false });
      expect(legacy.legacy_validity_flag).toBeTrue();

      const exported = Object.keys(labelModule);
      expect(exported).withContext('paymentModeLabel is gone').not.toContain('paymentModeLabel');
      expect(exported).withContext('subscriptionLabel is gone').not.toContain('subscriptionLabel');
    });
  });

  describe('activity', () => {
    it('translates every action the backend currently defines', () => {
      expect(activityActionLabel('admin.restaurant.lifecycle_transition')).toBe('Lifecycle changed');
      expect(activityActionLabel('admin.delegation.minted')).toBe('Delegated access granted');
      expect(activityActionLabel('admin.auth.lockout_cleared')).toBe('Lockout cleared');
    });

    it('translates the three Step 2G actions without a delivery word', () => {
      expect(activityActionLabel('admin.restaurant.created')).toBe('Restaurant created');
      expect(activityActionLabel('admin.restaurant.owner_invitation_reissued')).toBe(
        'Owner claim code reissued',
      );
      expect(activityActionLabel('admin.restaurant.owner_invitation_cancelled')).toBe(
        'Owner invitation cancelled',
      );
      // `reissued`, never `resent`: the audit action records a ROTATION, and the label
      // must not turn it into a delivery event that never happened.
      expect(activityActionLabel('admin.restaurant.owner_invitation_reissued')).not.toContain(
        'sent',
      );
    });

    it('humanises an action it does not know, rather than rendering nothing', () => {
      // `audit_actions.py` grows as capability lands. A blank row is worse than a
      // slightly mechanical one.
      expect(activityActionLabel('admin.receivable.mark_paid')).toBe('Receivable mark paid');
      expect(activityActionLabel('something.else')).toBe('Something else');
    });

    it('calls out a non-success result only', () => {
      expect(activityResultLabel('denied')).toBe('Refused');
      expect(activityResultIsNotable('denied')).toBeTrue();
      expect(activityResultIsNotable('failure')).toBeTrue();
      // §16 asks for badges sparingly: a successful action needs no decoration.
      expect(activityResultIsNotable('success')).toBeFalse();
    });
  });

  describe('lifecycle', () => {
    it('maps each state onto its own pill variant', () => {
      expect(lifecycleVariant('onboarding')).toBe('onboarding');
      expect(lifecycleVariant('live')).toBe('live');
      expect(lifecycleVariant('suspended')).toBe('suspended');
      expect(lifecycleVariant('offboarded')).toBe('offboarded');
    });
  });

  // ── ONBOARDING (Step 2C) ─────────────────────────────────────────────────────────
  //
  // Five closed vocabularies, and the failure mode is the same in each: a label that
  // reads as more reassurance than the server actually offered. These pin the exact
  // words, because the wording IS the contract with the operator.

  describe('onboarding source', () => {
    it('names a legacy adoption without claiming anything moved', () => {
      expect(onboardingSourceLabel('legacy_adopted')).toBe('Pre-existing restaurant');
      // "Imported" and "Migrated" both describe a transfer that never happened.
      for (const wrong of ['Imported', 'Migrated', 'Legacy adopted']) {
        expect(onboardingSourceLabel('legacy_adopted')).withContext(wrong).not.toBe(wrong);
      }
    });

    it('names an admin-created restaurant', () => {
      expect(onboardingSourceLabel('admin_created')).toBe('Created by Dinify Admin');
    });

    it('reports the untracked case as not tracked, never as a source', () => {
      expect(onboardingSourceLabel(null)).toBe('Not tracked');
    });

    it('explains "pre-existing" and says nothing else', () => {
      // The one phrase an operator can misread as a creation date.
      expect(onboardingSourceNote('legacy_adopted')).toBe(
        'This restaurant existed before the Admin onboarding record was introduced.',
      );
      expect(onboardingSourceNote('admin_created')).toBeNull();
      expect(onboardingSourceNote(null)).toBeNull();
    });

    it('never says the onboarding record is when the restaurant was created', () => {
      const note = onboardingSourceNote('legacy_adopted') ?? '';
      for (const wrong of ['Created on', 'Imported', 'Migrated']) {
        expect(note).withContext(wrong).not.toContain(wrong);
      }
    });
  });

  describe('owner relationship', () => {
    const CASES: readonly [OwnerRelationshipStatus, string][] = [
      ['unavailable', 'Not tracked'],
      ['consistent', 'Consistent'],
      ['missing_owner_membership', 'Owner access missing'],
      ['multiple_owner_memberships', 'Multiple active owners'],
      ['owner_membership_mismatch', 'Owner mismatch'],
    ];

    for (const [status, label] of CASES) {
      it(`translates ${status}`, () => {
        expect(ownerRelationshipLabel(status)).toBe(label);
        // The machine value itself must never be the answer.
        expect(ownerRelationshipLabel(status)).not.toBe(status);
      });
    }

    it('explains each inconsistency without deciding which identity is right', () => {
      expect(ownerRelationshipNote('missing_owner_membership')).toBe(
        'The owner of record does not currently hold active owner access.',
      );
      expect(ownerRelationshipNote('multiple_owner_memberships')).toBe(
        'More than one active user currently holds the owner role.',
      );
      expect(ownerRelationshipNote('owner_membership_mismatch')).toBe(
        'The owner of record and the active owner-role user do not match.',
      );
    });

    it('leaves the quiet states quiet', () => {
      // §10: a completed or unevaluated state recedes. No note, and no celebration.
      expect(ownerRelationshipNote('consistent')).toBeNull();
      expect(ownerRelationshipNote('unavailable')).toBeNull();
      expect(ownerRelationshipIsNotable('consistent')).toBeFalse();
      expect(ownerRelationshipIsNotable('unavailable')).toBeFalse();
    });

    it('marks exactly the three inconsistencies as notable', () => {
      expect(ownerRelationshipIsNotable('missing_owner_membership')).toBeTrue();
      expect(ownerRelationshipIsNotable('multiple_owner_memberships')).toBeTrue();
      expect(ownerRelationshipIsNotable('owner_membership_mismatch')).toBeTrue();
    });
  });

  describe('owner control', () => {
    const CASES: readonly [OwnerControlStatus, string][] = [
      ['unavailable', 'Not tracked'],
      ['not_established', 'Not established'],
      ['attested', 'Established'],
      ['invitation_redeemed', 'Established'],
      ['stale_attestation', 'Stale evidence'],
    ];

    for (const [status, label] of CASES) {
      it(`translates ${status}`, () => {
        expect(ownerControlLabel(status)).toBe(label);
        expect(ownerControlLabel(status)).not.toBe(status);
      });
    }

    it('keeps the two ESTABLISHED states apart by their evidence, not their label', () => {
      // Both are established. What differs is WHO did what — an administrator asserted
      // it, or the owner was observed redeeming an invitation.
      expect(ownerControlLabel('attested')).toBe(ownerControlLabel('invitation_redeemed'));
      expect(ownerControlEvidenceLabel('legacy_attestation')).toBe(
        'Recorded by administrative attestation',
      );
      expect(ownerControlEvidenceLabel('invitation_redeemed')).toBe('Owner invitation redeemed');
    });

    it('never describes an administrative attestation as the owner claiming anything', () => {
      const evidence = ownerControlEvidenceLabel('legacy_attestation') ?? '';
      for (const wrong of ['claimed', 'Claimed', 'signed in', 'redeemed']) {
        expect(evidence).withContext(wrong).not.toContain(wrong);
      }
    });

    it('has no evidence to name when there is none', () => {
      expect(ownerControlEvidenceLabel(null)).toBeNull();
    });

    it('says only that no evidence is recorded — not that an invitation went unclaimed', () => {
      const note = ownerControlNote('not_established') ?? '';
      expect(note).toBe('No owner-control evidence is recorded yet.');
      // For a legacy adoption no invitation ever applied, so blaming one would be false.
      expect(note).not.toContain('invitation');
    });

    it('explains stale evidence as belonging to a PREVIOUS owner', () => {
      const note = ownerControlNote('stale_attestation') ?? '';
      expect(note).toContain('previous owner');
      expect(note).toContain('does not establish control for the current owner');
    });

    it('marks only stale evidence as notable', () => {
      expect(ownerControlIsNotable('stale_attestation')).toBeTrue();
      for (const quiet of ['unavailable', 'not_established', 'attested', 'invitation_redeemed'] as const) {
        expect(ownerControlIsNotable(quiet)).withContext(quiet).toBeFalse();
      }
    });

    it('writes no note for the states whose label already says everything', () => {
      expect(ownerControlNote('attested')).toBeNull();
      expect(ownerControlNote('invitation_redeemed')).toBeNull();
      expect(ownerControlNote('unavailable')).toBeNull();
    });
  });

  describe('owner invitation', () => {
    const CASES: readonly [OwnerInvitationStatus, string][] = [
      ['unavailable', 'Not tracked'],
      ['not_applicable', 'Not applicable'],
      ['not_issued', 'Not issued'],
      ['pending', 'Pending'],
      ['expired', 'Expired'],
      ['verification_locked', 'Verification locked'],
      ['consumed', 'Redeemed'],
      ['cancelled', 'Cancelled'],
      ['superseded', 'Superseded'],
    ];

    for (const [status, label] of CASES) {
      it(`translates ${status}`, () => {
        expect(ownerInvitationLabel(status)).toBe(label);
        expect(ownerInvitationLabel(status)).not.toBe(status);
      });
    }

    it('never describes an invitation as sent, delivered or resendable', () => {
      // ISSUANCE IS NOT DELIVERY. The platform hands a claim code to the operator and
      // delivers nothing, so no status word may imply a message went anywhere.
      for (const [status] of CASES) {
        for (const forbidden of ['Sent', 'Delivered', 'Resend', 'Resent', 'Emailed', 'SMS']) {
          expect(ownerInvitationLabel(status)).withContext(`${status}: ${forbidden}`).not.toContain(forbidden);
          expect(ownerInvitationNote(status) ?? '').withContext(`${status}: ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it('explains every actionable state in a sentence, and stays silent where the label suffices', () => {
      expect(ownerInvitationNote('not_issued')).toContain('No claim code has been issued');
      expect(ownerInvitationNote('pending')).toContain('enter the claim code in the restaurant portal');
      expect(ownerInvitationNote('expired')).toContain('can no longer be redeemed');
      // LOCKED IS NOT EXPIRED. Both are unclaimable and both are remedied by a reissue,
      // but only one of them says somebody sat there guessing — the backend gives it
      // precedence over `expired` for exactly that reason, and the note says why.
      expect(ownerInvitationNote('verification_locked')).toContain('failed verification attempts');
      expect(ownerInvitationNote('verification_locked')).not.toContain('expired');
      expect(ownerInvitationNote('consumed')).toContain('redeemed');
      expect(ownerInvitationNote('cancelled')).toContain('cannot be redeemed');
      expect(ownerInvitationNote('superseded')).toContain('replaced by a later one');
      expect(ownerInvitationNote('not_applicable')).toBeNull();
      expect(ownerInvitationNote('unavailable')).toBeNull();
    });

    it('NEVER collapses not_applicable into not_issued', () => {
      // A legacy-adopted restaurant never had an invitation to issue. Reading the first
      // as the second invents a missing step for every tenant that predates the domain.
      expect(ownerInvitationLabel('not_applicable')).not.toBe(
        ownerInvitationLabel('not_issued'),
      );
    });

    it('marks exactly the two unclaimable-but-unresolved states as notable', () => {
      // Step 2C marked ONLY `expired`; Step 2G added `verification_locked`, which is the
      // same operational situation — a credential still holding the slot that can no
      // longer be redeemed — arrived at by an attacker rather than a clock.
      expect(ownerInvitationIsNotable('expired')).toBeTrue();
      expect(ownerInvitationIsNotable('verification_locked')).toBeTrue();
      // Pending is waiting, not failing; cancelled and superseded were decisions.
      for (const quiet of [
        'unavailable',
        'not_applicable',
        'not_issued',
        'pending',
        'consumed',
        'cancelled',
        'superseded',
      ] as const) {
        expect(ownerInvitationIsNotable(quiet)).withContext(quiet).toBeFalse();
      }
    });
  });

  describe('no machine value reaches an operator', () => {
    it('translates every value in every onboarding vocabulary', () => {
      // The whole point of this file. A raw snake_case value on this panel would be a
      // regression the type system cannot catch, so it is asserted directly.
      const rendered = [
        onboardingSourceLabel('legacy_adopted'),
        onboardingSourceLabel('admin_created'),
        ...(['unavailable', 'consistent', 'missing_owner_membership', 'multiple_owner_memberships', 'owner_membership_mismatch'] as const).map(
          ownerRelationshipLabel,
        ),
        ...(['unavailable', 'not_established', 'attested', 'invitation_redeemed', 'stale_attestation'] as const).map(
          ownerControlLabel,
        ),
        ...(['unavailable', 'not_applicable', 'not_issued', 'pending', 'expired', 'verification_locked', 'consumed', 'cancelled', 'superseded'] as const).map(
          ownerInvitationLabel,
        ),
        ownerControlEvidenceLabel('legacy_attestation') ?? '',
        ownerControlEvidenceLabel('invitation_redeemed') ?? '',
      ];

      for (const label of rendered) {
        expect(label).withContext(label).not.toContain('_');
      }
    });
  });
});
