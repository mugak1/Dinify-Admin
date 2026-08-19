import { formatAmount, formatUGX, NO_AMOUNT } from './currency';
import { formatEat, formatEatDate, formatEatTime, formatRelativeToServer, NO_TIME } from './time';

describe('formatUGX', () => {
  it('renders the spec form: UGX 150,000', () => {
    expect(formatUGX('150000.00')).toBe('UGX 150,000');
  });

  it('never shows decimals, whatever the wire carries', () => {
    // No faux precision (§16). A restaurant is not billed in fractions of a shilling.
    expect(formatUGX('150000.99')).toBe('UGX 150,000');
    expect(formatUGX('0.50')).toBe('UGX 0');
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
