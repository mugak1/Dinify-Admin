/**
 * The `GET /api/admin/v1/auth/session/` response body, verbatim.
 *
 * Exactly six fields — read from `platform_admin_app/endpoints/auth.py::AdminSessionView`
 * during recon, not from a summary.
 */
export interface AdminSessionResponse {
  /** Platform-staff username. */
  readonly username: string;
  readonly email: string;
  /** ISO 8601. When this session was minted. */
  readonly issued_at: string;
  /**
   * ISO 8601. `AdminSession.absolute_expiry`, fixed at issuance from
   * `ADMIN_SESSION_ABSOLUTE_LIFETIME` (8 hours).
   *
   * DO NOT BUILD A COUNTDOWN FROM THIS — see `SessionStore`.
   */
  readonly expires_at: string;
  /** ISO 8601, or null if this session has never cleared a second factor. */
  readonly elevated_at: string | null;
  /**
   * ISO 8601. The server's own clock at the moment it answered.
   *
   * This is the anchor for every relative time and every staleness calculation in the
   * application. Administration may happen from another timezone on a machine whose
   * clock is wrong; the server's is the only one worth trusting.
   */
  readonly server_time: string;
}

/** `POST /auth/login/` — 200 means the password was accepted; a session does NOT exist yet. */
export interface AdminLoginResponse {
  readonly second_factor_required: boolean;
  /**
   * TRUE means BREAK-GLASS: the account is locked out, and the challenge just issued
   * accepts a RECOVERY CODE ONLY — a TOTP code will be refused as an ordinary bad
   * code. Without honouring this the only way out of a lockout is
   * `manage.py unlock_platform_admin` on the box, which defeats having a portal.
   */
  readonly recovery_code_required: boolean;
}

/** `POST /auth/verify/` — 200 means a session now exists and the CSRF cookie was rotated. */
export interface AdminVerifyResponse {
  readonly username: string;
  readonly expires_at: string;
  readonly used_recovery_code: boolean;
  /** True when this sign-in CLEARED an account lockout (the break-glass path). */
  readonly lockout_cleared: boolean;
  readonly recovery_codes_remaining: number;
}

/** `POST /auth/elevate/` — 200 means the session is now recently-elevated. */
export interface AdminElevateResponse {
  readonly elevated_at: string;
  readonly used_recovery_code: boolean;
  readonly recovery_codes_remaining: number;
}

/**
 * The second factor is METHOD-EXPLICIT and has NO DEFAULT.
 *
 * The backend deliberately removed try-TOTP-then-fall-through-to-recovery: TOTP
 * decrypts the stored secret before it can reject a code, and the crypto layer fails
 * closed, so a lost `ADMIN_SECRET_ENCRYPTION_KEY` raised out of the TOTP attempt and
 * the recovery branch was never reached — one key took both factors down with it.
 * Sending a default here would reinstate exactly that ordering.
 */
export type SecondFactorMethod = 'totp' | 'recovery';
