/**
 * Money formatting. `UGX 150,000` — no decimals, no faux precision (spec §16).
 *
 * WHY THIS DOES NOT PARSE A DECIMAL STRING INTO A NUMBER. The backend's monetary
 * fields are PostgreSQL `DecimalField`s and arrive on the wire as STRINGS
 * (`"150000.00"`), specifically so no float ever touches a money value. Turning that
 * string into a JavaScript number to format it would reintroduce the exact hazard the
 * backend went to the trouble of avoiding — for display, where the only thing gained
 * is convenience.
 *
 * So a string input is grouped TEXTUALLY: the integer part is split into thousands by
 * character, the fractional part is dropped (there are no decimals in the output
 * anyway), and no arithmetic happens at all. A number input is rounded and grouped
 * with `Intl`, because a caller who already has a number has already made that
 * choice.
 */

/** Rendered when there is no value. Never `UGX 0` — nothing and nil are different. */
export const NO_AMOUNT = '—';

/**
 * Format a shilling amount.
 *
 * @param amount a decimal string from the API (preferred), or a number.
 */
export function formatUGX(amount: string | number | null | undefined): string {
  const digits = groupedDigits(amount);
  return digits === null ? NO_AMOUNT : `UGX ${digits}`;
}

/** The grouped figure alone, for a column that carries its own `UGX` header. */
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

  const match = /^(-?)(\d+)(?:\.\d+)?$/.exec(trimmed);
  if (!match) return null;

  const [, sign, whole] = match;
  return `${sign}${groupThousands(whole)}`;
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
