import {
  activityActionLabel,
  activityResultIsNotable,
  activityResultLabel,
  isNotConfigured,
  lifecycleVariant,
  paymentModeLabel,
  readinessBlockerLabel,
  readinessLabel,
  subscriptionLabel,
  subscriptionMethodLabel,
} from './restaurant.labels';
import { ReadinessSummary, SubscriptionSummary } from './restaurant.model';

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
});
