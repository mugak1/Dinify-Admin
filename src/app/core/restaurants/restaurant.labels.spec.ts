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
  ownerRelationshipIsNotable,
  ownerRelationshipLabel,
  ownerRelationshipNote,
  paymentModeLabel,
  readinessBlockerLabel,
  readinessLabel,
  subscriptionLabel,
  subscriptionMethodLabel,
} from './restaurant.labels';
import {
  OwnerControlStatus,
  OwnerInvitationStatus,
  OwnerRelationshipStatus,
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

  describe('payment mode', () => {
    it('says not configured, and infers nothing', () => {
      expect(paymentModeLabel({ payment_mode: null, payment_mode_configured: false })).toBe(
        'Not configured',
      );
    });

    it('renders a real mode when a field finally exists to hold one', () => {
      expect(paymentModeLabel({ payment_mode: 'cash_only', payment_mode_configured: true })).toBe(
        'Cash only',
      );
    });
  });

  describe('subscription', () => {
    it('says not configured while there is no commercial subscription', () => {
      expect(subscriptionLabel(subscription())).toBe('Not configured');
    });

    it('does NOT upgrade the legacy validity flag into a billing status', () => {
      // `legacy_validity_flag` defaults true and nothing maintains it. An operator who
      // reads "Paid" stops chasing an invoice that was never raised.
      const label = subscriptionLabel(subscription({ legacy_validity_flag: true }));
      for (const invented of ['Active', 'Paid', 'Current', 'Trial', 'In good standing']) {
        expect(label).withContext(invented).not.toBe(invented);
      }
    });

    it('humanises the legacy billing method', () => {
      expect(subscriptionMethodLabel('per_order')).toBe('Per order');
      expect(subscriptionMethodLabel(null)).toBe('—');
    });
  });

  describe('activity', () => {
    it('translates every action the backend currently defines', () => {
      expect(activityActionLabel('admin.restaurant.lifecycle_transition')).toBe('Lifecycle changed');
      expect(activityActionLabel('admin.delegation.minted')).toBe('Delegated access granted');
      expect(activityActionLabel('admin.auth.lockout_cleared')).toBe('Lockout cleared');
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

    it('NEVER collapses not_applicable into not_issued', () => {
      // A legacy-adopted restaurant never had an invitation to issue. Reading the first
      // as the second invents a missing step for every tenant that predates the domain.
      expect(ownerInvitationLabel('not_applicable')).not.toBe(
        ownerInvitationLabel('not_issued'),
      );
    });

    it('marks only an expired invitation as notable', () => {
      expect(ownerInvitationIsNotable('expired')).toBeTrue();
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
        ...(['unavailable', 'not_applicable', 'not_issued', 'pending', 'expired', 'consumed', 'cancelled', 'superseded'] as const).map(
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
