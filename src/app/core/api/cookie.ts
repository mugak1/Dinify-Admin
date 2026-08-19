/**
 * Read one cookie BY EXACT NAME.
 *
 * A substring or `indexOf` match can be fooled by another cookie whose VALUE happens
 * to contain the name — `document.cookie` is one flat string and values are largely
 * unconstrained, so `analytics=...__Host-dinify_admin_csrftoken...` would satisfy a
 * naive search and hand back the wrong token. This splits on `;`, splits each pair at
 * its FIRST `=` (values may contain `=`), and compares the trimmed name for equality.
 *
 * The `__Host-` prefix needs no special handling: it is simply part of the name. All
 * the prefix does is constrain how the SERVER may set the cookie (Secure, Path=/, no
 * Domain) — the browser exposes it to `document.cookie` under its full literal name.
 */
export function readCookie(name: string, cookieString: string = document.cookie): string | null {
  if (!name || !cookieString) return null;

  for (const pair of cookieString.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() !== name) continue;

    const raw = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape must not throw out of an interceptor.
      return raw;
    }
  }
  return null;
}
