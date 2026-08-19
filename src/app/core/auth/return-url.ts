/** Where an operator lands when no usable return URL survives validation. */
export const DEFAULT_RETURN_URL = '/';

/**
 * True when `value` holds any control character or whitespace.
 *
 * Written as a code-point scan rather than a regular expression on purpose: a
 * character class spanning the control range is both invisible in review (a literal
 * tab or newline looks like nothing) and flagged by `no-control-regex`. Suppressing
 * that rule to keep a less readable form would be the wrong trade in a file whose
 * whole job is to be obviously correct.
 */
function hasControlOrWhitespace(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validate a `returnUrl` on the way OUT of the login page.
 *
 * THIS IS THE CONTROL PLANE'S OWN LOGIN PAGE. An open redirect here is a real
 * finding, not a theoretical one: `admin.dinifyapp.com/login?returnUrl=...` is a
 * plausible-looking link that would bounce a platform administrator — the account
 * that can suspend tenants and mint delegations — onto an attacker's page
 * immediately after they typed a password and a TOTP code.
 *
 * ACCEPT: same-origin relative paths only, i.e. a single leading `/` followed by a
 * path, with an optional query string and fragment.
 *
 * REJECT, and why each one is checked separately:
 *
 *   `https://evil.com`  — any scheme at all. Matched generically rather than by
 *                         name, so `javascript:`, `data:` and the next scheme
 *                         somebody thinks of are covered by the same rule.
 *   `//evil.com`        — protocol-relative. Reads as a path and is not one; this is
 *                         the classic bypass of a naive "must start with /" check.
 *   `/\evil.com`        — browsers normalise `\` to `/` inside a URL, so this becomes
 *                         `//evil.com` after parsing. ANY backslash is refused rather
 *                         than trying to predict which position is exploitable.
 *   whitespace/controls — a leading tab or newline is stripped by URL parsers, which
 *                         can carry a scheme past a check that ran on the raw string.
 *
 * Rejection FALLS BACK to `/` rather than throwing: an operator who has just
 * authenticated must land somewhere useful, not on an error.
 */
export function sanitiseReturnUrl(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_RETURN_URL;

  const value = raw.trim();
  if (!value) return DEFAULT_RETURN_URL;

  // Control characters or embedded whitespace — parsers strip these, so a check on
  // the raw string is not a check on what the browser will navigate to.
  if (hasControlOrWhitespace(value)) return DEFAULT_RETURN_URL;

  // Any backslash. `\` is normalised to `/`, so `/\evil.com` is `//evil.com`.
  if (value.includes('\\')) return DEFAULT_RETURN_URL;

  // Any scheme, named generically: letter followed by letters/digits/+/-/. then ':'.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return DEFAULT_RETURN_URL;

  // Exactly one leading slash. Two is protocol-relative.
  if (!value.startsWith('/') || value.startsWith('//')) return DEFAULT_RETURN_URL;

  return value;
}
