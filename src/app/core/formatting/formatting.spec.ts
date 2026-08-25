import { formatAmount, formatMoney, formatUGX, NO_AMOUNT } from './currency';
import {
  eatWallTimeToIso,
  formatEat,
  formatEatDate,
  formatEatTime,
  formatRelativeToServer,
  NO_TIME,
} from './time';

describe('formatUGX', () => {
  it('renders the spec form: UGX 150,000', () => {
    expect(formatUGX('150000.00')).toBe('UGX 150,000');
  });

  it('drops an ALL-ZERO fraction as faux precision (§16)', () => {
    // `UGX 150,000`, not `UGX 150,000.00`. Trailing zeroes claim a precision the price
    // does not have and make a column of figures harder to scan.
    expect(formatUGX('150000.00')).toBe('UGX 150,000');
    expect(formatUGX('0.00')).toBe('UGX 0');
    expect(formatUGX('1500.000')).toBe('UGX 1,500');
  });

  it('KEEPS A NON-ZERO FRACTION — truth beats typography', () => {
    // This formatter used to truncate unconditionally, which deleted a stored digit
    // from a price an operator is expected to reconcile. A recorded amount is a fact,
    // and rounding one away on screen is the portal asserting something tidier than
    // what the database holds — the same defect class as rendering unconfigured
    // commercial state as `Active`.
    expect(formatUGX('150000.50')).toBe('UGX 150,000.50');
    expect(formatUGX('150000.99')).toBe('UGX 150,000.99');
    expect(formatUGX('0.50')).toBe('UGX 0.50');
    expect(formatUGX('0.01')).toBe('UGX 0.01');
  });

  it('preserves the fraction VERBATIM rather than re-scaling it', () => {
    // The server's scale is the scale the column was stored at. Every reformatting is
    // another chance to corrupt the figure, so there is none.
    expect(formatUGX('4500.5')).toBe('UGX 4,500.5');
    expect(formatUGX('4500.500')).toBe('UGX 4,500.500');
  });

  /**
   * The backend's monetary fields are Postgres DecimalFields and arrive as STRINGS
   * precisely so no float ever touches a money value. Grouping a string textually
   * keeps that property on this side too.
   */
  it('groups a decimal string without parsing it into a number', () => {
    expect(formatUGX('12345678901234567890')).toBe('UGX 12,345,678,901,234,567,890');
  });

  it('groups every boundary correctly', () => {
    expect(formatUGX('0')).toBe('UGX 0');
    expect(formatUGX('7')).toBe('UGX 7');
    expect(formatUGX('999')).toBe('UGX 999');
    expect(formatUGX('1000')).toBe('UGX 1,000');
    expect(formatUGX('1000000')).toBe('UGX 1,000,000');
  });

  it('handles a negative amount and a leading-zero string', () => {
    expect(formatUGX('-4500')).toBe('UGX -4,500');
    expect(formatUGX('0001500')).toBe('UGX 1,500');
  });

  it('accepts a number, rounding for display', () => {
    expect(formatUGX(150000)).toBe('UGX 150,000');
    expect(formatUGX(1499.6)).toBe('UGX 1,500');
  });

  it('renders nothing-at-all distinctly from zero', () => {
    // "No invoice" and "an invoice for nothing" are different facts.
    expect(formatUGX(null)).toBe(NO_AMOUNT);
    expect(formatUGX(undefined)).toBe(NO_AMOUNT);
    expect(formatUGX('')).toBe(NO_AMOUNT);
    expect(formatUGX('not-a-number')).toBe(NO_AMOUNT);
    expect(formatUGX(Number.NaN)).toBe(NO_AMOUNT);
    expect(formatUGX(0)).toBe('UGX 0');
  });

  it('formatAmount drops the unit for a column that carries it in the header', () => {
    expect(formatAmount('150000')).toBe('150,000');
  });
});

/**
 * `formatMoney` is the general rule and `formatUGX` is a one-line wrapper over it, so
 * there is ONE money rule in this application rather than two that can drift about
 * whether a stored fraction survives.
 */
describe('formatMoney', () => {
  it('labels the amount with the currency it was given', () => {
    expect(formatMoney('150000.00', 'UGX')).toBe('UGX 150,000');
    expect(formatMoney('4500.75', 'KES')).toBe('KES 4,500.75');
    expect(formatMoney('1200000', 'TZS')).toBe('TZS 1,200,000');
  });

  it('DOES NOT ASSUME UGX', () => {
    // `RestaurantSubscriptionTerms.currency` is stored with no default and takes any
    // three-letter ISO-4217 code. Relabelling a different currency as shillings is a
    // quiet corruption of a money value — the one thing this module exists to prevent.
    expect(formatMoney('4500.75', 'KES')).not.toContain('UGX');
    expect(formatMoney('4500.75', 'KES')).toContain('KES');
  });

  it('still renders the figure when no currency code came with it', () => {
    // Dropping the amount because the code is missing would lose more than it protects.
    // What it must never do is label the figure with a currency it guessed.
    expect(formatMoney('150000.00', '')).toBe('150,000');
    expect(formatMoney('150000.00', '   ')).toBe('150,000');
  });

  it('treats a missing amount as absent, and zero as a real price', () => {
    expect(formatMoney(null, 'UGX')).toBe(NO_AMOUNT);
    expect(formatMoney(undefined, 'UGX')).toBe(NO_AMOUNT);
    expect(formatMoney('', 'UGX')).toBe(NO_AMOUNT);
    // Zero is a deliberate recorded price — a waived period, a pilot — and is a
    // DIFFERENT fact from having no amount at all.
    expect(formatMoney('0.00', 'UGX')).toBe('UGX 0');
    expect(formatMoney('0.00', 'UGX')).not.toBe(NO_AMOUNT);
  });

  it('never parses a decimal string into a number', () => {
    // A value beyond IEEE-754 range survives intact only if no arithmetic happens.
    expect(formatMoney('12345678901234567890.25', 'UGX')).toBe('UGX 12,345,678,901,234,567,890.25');
  });
});

describe('EAT time formatting', () => {
  // 2026-08-19T12:42Z is 15:42 in Kampala (UTC+3, no daylight saving).
  const ISO = '2026-08-19T12:42:00+00:00';

  it('renders the spec form: 15:42 EAT · 19 Aug 2026', () => {
    expect(formatEat(ISO)).toBe('15:42 EAT · 19 Aug 2026');
  });

  it('labels the zone, because administration may happen from another one', () => {
    // "Yesterday at 23:50" must never be ambiguous — a lifecycle decision against the
    // wrong day is not a cosmetic error.
    expect(formatEat(ISO)).toContain('EAT');
    expect(formatEatTime(ISO)).toBe('15:42 EAT');
  });

  it('converts into Kampala time regardless of the machine running the test', () => {
    // 22:30 UTC is the NEXT day in Kampala. A formatter using local time would fail
    // this on most of the planet.
    expect(formatEat('2026-08-19T22:30:00+00:00')).toBe('01:30 EAT · 20 Aug 2026');
  });

  it('reads an offset-bearing timestamp as an absolute instant', () => {
    // Same moment, three spellings.
    expect(formatEat('2026-08-19T15:42:00+03:00')).toBe(formatEat(ISO));
    expect(formatEat('2026-08-19T12:42:00Z')).toBe(formatEat(ISO));
  });

  it('renders a date alone for a column where the time is noise', () => {
    expect(formatEatDate(ISO)).toBe('19 Aug 2026');
  });

  it('renders a placeholder rather than an Invalid Date', () => {
    expect(formatEat(null)).toBe(NO_TIME);
    expect(formatEat('')).toBe(NO_TIME);
    expect(formatEat('yesterday')).toBe(NO_TIME);
  });
});

describe('formatRelativeToServer', () => {
  const NOW = Date.parse('2026-08-19T12:00:00+00:00');

  it('is anchored on the argument, never on the browser clock', () => {
    expect(formatRelativeToServer('2026-08-19T11:56:00+00:00', NOW)).toBe('4 minutes ago');
    expect(formatRelativeToServer('2026-08-19T09:00:00+00:00', NOW)).toBe('3 hours ago');
    expect(formatRelativeToServer('2026-08-17T12:00:00+00:00', NOW)).toBe('2 days ago');
  });

  it('collapses the last minute to "just now"', () => {
    expect(formatRelativeToServer('2026-08-19T11:59:30+00:00', NOW)).toBe('just now');
  });

  it('handles a future instant, which clock skew can produce', () => {
    expect(formatRelativeToServer('2026-08-19T12:05:00+00:00', NOW)).toBe('in 5 minutes');
  });

  it('returns null with no server anchor, so the caller shows an absolute time', () => {
    // Falling back to Date.now() would silently reintroduce exactly the skew the
    // server anchor exists to avoid.
    expect(formatRelativeToServer('2026-08-19T11:56:00+00:00', null)).toBeNull();
    expect(formatRelativeToServer(null, NOW)).toBeNull();
  });
});

/**
 * WRITING a commercial moment (Step 3E.3).
 *
 * The failure this guards is silent: `new Date('2026-08-25T15:00').toISOString()`
 * reads the wall time in the BROWSER'S zone, so an operator in London would send
 * 15:00 BST — 17:00 EAT — on a field that decides which terms were in force. The
 * backend refuses naive timestamps, so the bug would not surface as a 400; it would
 * surface as a well-formed request carrying the wrong instant.
 */
describe('eatWallTimeToIso', () => {
  it('carries an EXPLICIT offset, never a naive value', () => {
    expect(eatWallTimeToIso('2026-08-25T15:00')).toBe('2026-08-25T15:00:00+03:00');
    // The backend's own accepted shape.
    expect(eatWallTimeToIso('2026-08-25T15:00')).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('keeps the stated wall time, whatever the browser timezone is', () => {
    // THE POINT OF THE HELPER. Whether this suite runs in Kampala, London or UTC, the
    // operator typed 15:00 EAT and 15:00 EAT is what goes on the wire. The assertion
    // is the same in every zone precisely because the browser's is never consulted.
    const iso = eatWallTimeToIso('2026-08-25T15:00');
    expect(iso).toBe('2026-08-25T15:00:00+03:00');

    // And it denotes the instant it should: 15:00+03:00 is 12:00Z.
    expect(new Date(iso as string).toISOString()).toBe('2026-08-25T12:00:00.000Z');
  });

  it('is NOT the naive-plus-browser-zone answer', () => {
    // Written as an explicit contrast so the test states what it is protecting
    // against. These agree only when the browser happens to be on EAT.
    const naive = new Date('2026-08-25T15:00').toISOString();
    const correct = new Date(eatWallTimeToIso('2026-08-25T15:00') as string).toISOString();
    const browserIsEat = new Date('2026-08-25T15:00').getTimezoneOffset() === -180;
    if (browserIsEat) {
      expect(naive).toBe(correct);
    } else {
      expect(naive).not.toBe(correct);
    }
  });

  it('accepts an explicit seconds component', () => {
    expect(eatWallTimeToIso('2026-08-25T15:00:30')).toBe('2026-08-25T15:00:30+03:00');
  });

  it('refuses anything that is not a complete wall time', () => {
    // Null rather than a guess: the caller renders a field error instead of sending a
    // moment the operator did not state.
    for (const bad of ['', '   ', '2026-08-25', '15:00', 'not a time', '2026-08-25T15']) {
      expect(eatWallTimeToIso(bad)).withContext(bad).toBeNull();
    }
    expect(eatWallTimeToIso(null)).toBeNull();
    expect(eatWallTimeToIso(undefined)).toBeNull();
  });

  it('round-trips through the EAT reader', () => {
    // What the operator typed is what they are shown back.
    const iso = eatWallTimeToIso('2026-08-25T15:00') as string;
    expect(formatEat(iso)).toBe('15:00 EAT · 25 Aug 2026');
  });
});
