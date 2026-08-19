/**
 * The build-time environment contract.
 *
 * Deliberately tiny. The one thing worth noting is what is ABSENT: there is no API
 * host, no `withCredentials`, and no CORS configuration anywhere in this repo.
 */
export interface Environment {
  readonly production: boolean;

  /**
   * The API base, RELATIVE and never absolute.
   *
   * The SPA is served by Apache from `/var/www/dinify-admin` on
   * `admin.dinifyapp.com`, and Django is mounted on THE SAME ORIGIN at `/api` (which
   * Apache strips, so `/api/admin/v1/auth/login/` reaches Django as
   * `/admin/v1/auth/login/`). Same-origin has three consequences that are easy to
   * undo by accident and expensive to debug:
   *
   *   - a relative base is correct, and an absolute host would turn every request
   *     cross-origin and break the `__Host-` cookies outright;
   *   - `withCredentials` is unnecessary — same-origin requests send cookies anyway,
   *     and setting it invites the reflex to add CORS to "fix" a failure;
   *   - the admin plane's CORS posture is hardcoded shut in `settings_admin.py`
   *     (`CORS_ALLOWED_ORIGINS = []`, `CORS_ALLOW_CREDENTIALS = False`), so a
   *     cross-origin build cannot be made to work — only to look broken.
   */
  readonly apiBase: string;

  /**
   * Serve the mock authentication implementation instead of the real one.
   *
   * True only in development builds. The production build additionally FILE-REPLACES
   * `src/app/dev/dev-tools.ts`, so the mock and the primitives gallery are not in the
   * production module graph at all — this flag is not what keeps them out. See
   * scripts/check-mock-isolation.mjs.
   */
  readonly useMockApi: boolean;
}
