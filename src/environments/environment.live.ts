import { Environment } from './environment.interface';

/**
 * `ng serve --configuration=live` — a development build wired to the REAL API.
 *
 * Same-origin only: run it behind something that serves this app and proxies `/api`
 * to the admin WSGI daemon. Pointing `apiBase` at another host will not work — the
 * session and CSRF cookies are `__Host-` prefixed and therefore host-only.
 */
export const environment: Environment = {
  production: false,
  apiBase: '/api/admin/v1',
  useMockApi: false,
};
