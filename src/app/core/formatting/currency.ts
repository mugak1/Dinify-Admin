/**
 * Money formatting. `UGX 150,000` — the spec §16 form, with one exception that matters.
 *
 * ── WHY THIS DOES NOT PARSE A DECIMAL STRING INTO A NUMBER ────────────────────────
 *
 * The backend's monetary fields are PostgreSQL `DecimalField`s and arrive on the wire
 * as STRINGS (`"150000.00"`), specifically so no float ever touches a money value —
 * `commercial_reads` calls `str()` on the `Decimal` for exactly this reason, because
 * DRF's encoder would otherwise emit a float and a value not representable in binary
 * floating point would not survive the trip. Turning that string into a JavaScript
 * number to format it would reintroduce the hazard the backend went to the trouble of
 * avoiding, for display, where the only thing gained is convenience.
 *
 * So a string input is grouped TEXTUALLY: the integer part is split into thousands by
 * character and no arithmetic happens at all. A number input is rounded and grouped
 * with `Intl`, because a caller who already has a number has already made that choice.
 *
 * ── AND WHY THE FRACTION IS NOT ALWAYS DROPPED (Step 3E.1) ────────────────────────
 *
 * §16 asks for `UGX 150,000` and not `UGX 150,000.00`: a restaurant is not billed in
 * fractions of a shilling, and trailing zeroes are faux precision. That holds — an
 * ALL-ZERO fraction is dropped.
 *
 * But TRUTH BEATS TYPOGRAPHY. This formatter used to drop the fraction unconditionally,
 * which turned a stored `"150000.50"` into `UGX 150,000` — silently deleting a real,
 * recorded digit from a price an operator is expected to reconcile. A subscription
 * amount is a stored fact, and rounding one away on screen is the same defect class as
 * rendering an unconfigured state as `Active`: the portal asserting something tidier
 * than what the database holds.
 *
 * So a NON-ZERO fraction is preserved, VERBATIM as the server sent it. Verbatim rather
 * than reformatted, because every reformatting is another chance to corrupt the figure,
 * and the server's scale is already the scale the column was stored at.
 *
 *   "150000.00"  ->  UGX 150,000       (all-zero fraction: faux precision, dropped)
 *   "0.00"       ->  UGX 0             (a real, deliberate price — not "free")
 *   "150000.50"  ->  UGX 150,000.50    (a stored digit, kept)
 *
 * ── AND WHY THE CURRENCY IS AN ARGUMENT ──────────────────────────────────────────
 *
 * `RestaurantSubscriptionTerms.currency` is a three-letter ISO-4217 code stored with NO
 * default — "somebody chose UGX" and "the column defaulted" are kept distinguishable on
 * purpose. Uganda is the launch market, not a law about the schema, so a formatter that
 * hardcoded `UGX` would relabel a genuinely different currency as shillings. That is a
 * quiet corruption of a money value, which is the one thing this module exists to make
 * impossible.
 */

/** Rendered when there is no value. Never `UGX 0` — nothing and nil are different. */
export const NO_AMOUNT = '—';

/**
 * Format an amount in an explicit currency: `UGX 150,000`, `KES 4,500.75`.
 *
 * @param amount   a decimal string from the API (preferred), or a number.
 * @param currency an ISO-4217 code, taken from the same record as the amount.
 */
export function formatMoney(
  amount: string | number | null | undefined,
  currency: string,
): string {
  const digits = groupedDigits(amount);
  if (digits === null) return NO_AMOUNT;

  // An amount with no currency beside it is still worth showing — dropping the figure
  // because the code is missing would lose more than it protects — but it is never
  // labelled with a currency this module guessed.
  const code = currency.trim();
  return code ? `${code} ${digits}` : digits;
}

/**
 * Format a shilling amount.
 *
 * The launch-market convenience wrapper, and nothing more: it delegates to
 * `formatMoney` so there is ONE money rule in this application rather than two that can
 * drift about whether a stored fraction survives.
 *
 * @param amount a decimal string from the API (preferred), or a number.
 */
export function formatUGX(amount: string | number | null | undefined): string {
  return formatMoney(amount, 'UGX');
}

/** The grouped figure alone, for a column that carries its own currency in the header. */
export function formatAmount(amount: string | number | null | undefined): string {
  return groupedDigits(amount) ?? NO_AMOUNT;
}

function groupedDigits(amount: string | number | null | undefined): string | null {
  if (amount === null || amount === undefined) return null;

  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(amount));
  }

  const trimmed = amount.trim();
  if (!trimmed) return null;

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole, fraction] = match;
  return `${sign}${groupThousands(whole)}${significantFraction(fraction)}`;
}

/**
 * The fractional part, or `''` where showing it would be faux precision.
 *
 * Kept EXACTLY as the server spelled it whenever any digit is non-zero — no rounding,
 * no padding, no re-scaling. The only judgement made here is "are these all zeroes",
 * which is the one question §16's no-decimals rule actually turns on.
 */
function significantFraction(fraction: string | undefined): string {
  if (!fraction) return '';
  return /[1-9]/.test(fraction) ? `.${fraction}` : '';
}

/** Group an integer string into thousands, right to left. No arithmetic. */
function groupThousands(whole: string): string {
  const normalised = whole.replace(/^0+(?=\d)/, '');
  let out = '';
  for (let i = 0; i < normalised.length; i += 1) {
    const fromRight = normalised.length - i;
    out += normalised[i];
    if (fromRight > 1 && fromRight % 3 === 1) out += ',';
  }
  return out;
}
