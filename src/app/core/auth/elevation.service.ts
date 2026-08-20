import { inject, Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { extractErrorMessage } from '../api/error-message';
import { AdminServiceStatus } from '../api/service-status';
import {
  classifyTransportFailure,
  extractRequestId,
  TransportFailure,
} from '../api/transport-failure';
import { NoticeService } from '../notices/notice.service';
import { ADMIN_AUTH } from './admin-auth.api';
import { SecondFactorMethod } from './session.model';
import { SessionStore } from './session.store';

/**
 * Thrown into every queued request when the operator dismisses the re-elevation
 * modal. An EXPLICIT cancelled state: nothing hangs silently waiting for an
 * elevation that is never coming.
 */
export class ElevationCancelledError extends Error {
  readonly cancelled = true;

  constructor() {
    super('Re-authentication was cancelled.');
    this.name = 'ElevationCancelledError';
  }
}

/**
 * Thrown into every queued request when the elevation CANNOT be completed at all — the
 * service did not answer, or the session ended underneath it.
 *
 * Distinct from a cancellation: nobody chose this. Distinct from a refused code, which
 * keeps the modal open so the operator can try again — retrying against a service that
 * is not answering is a loop, and leaving the queue attached to it is a hang.
 */
export class ElevationAbandonedError extends Error {
  readonly abandoned = true;

  constructor(
    readonly failure: TransportFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ElevationAbandonedError';
  }
}

/**
 * WHY the prompt is open. It changes one sentence and nothing else.
 *
 *   'action-required'  a request was refused for stale elevation and is waiting.
 *   'deliberate'       the operator asked for it from the operator menu, before
 *                      starting something consequential.
 *
 * Telling an operator who just clicked Re-authenticate that "this action needs a
 * second factor" describes an action they have not taken yet.
 */
export type ElevationReason = 'action-required' | 'deliberate';

/**
 * Step-up re-authentication — A SINGLETON WITH A QUEUE.
 *
 * Three concurrent requests refused for stale elevation must not open three modals.
 * The first one opens it; the rest attach to the same in-flight attempt. One
 * elevation runs, and on success EVERY queued request is replayed once.
 *
 * The failure mode being designed out is: the operator clicks Suspend and gets a
 * mysterious 403. Stale elevation is an EXPECTED SECURITY STATE, not an error — the
 * session is perfectly valid, it simply has not cleared a second factor in the last
 * five minutes — so the interface asks for the factor and finishes what was started.
 *
 * WHAT THIS SERVICE DOES NOT DO: it never retries the elevation itself. A refused
 * code (case 4 of the classifier) is shown INSIDE the modal and the operator tries
 * again deliberately; a request replayed after a successful elevation that is refused
 * for elevation a SECOND time is a defect and is surfaced as one, not looped on.
 */
@Injectable({ providedIn: 'root' })
export class ElevationService {
  private readonly api = inject(ADMIN_AUTH);
  private readonly store = inject(SessionStore);
  private readonly notices = inject(NoticeService);
  private readonly status = inject(AdminServiceStatus);

  /** The in-flight attempt every queued request is subscribed to, or null. */
  private attempt: Subject<void> | null = null;

  readonly isOpen = signal(false);
  /** Why the prompt is open. Drives one sentence in the dialog. */
  readonly reason = signal<ElevationReason>('action-required');
  /** Explicit and defaulted only in the UI — the wire value is never inferred. */
  readonly method = signal<SecondFactorMethod>('totp');
  readonly submitting = signal(false);
  /** The server's own message from a refused code. Displayed verbatim. */
  readonly error = signal<string | null>(null);
  /** How many requests are waiting on this elevation. Shown in the modal. */
  readonly waiting = signal(0);

  /**
   * Join (or start) the in-flight elevation.
   *
   * Completes when the second factor is accepted; errors with
   * `ElevationCancelledError` when the operator dismisses the modal.
   */
  request(reason: ElevationReason = 'action-required'): Observable<void> {
    if (!this.attempt) {
      this.attempt = new Subject<void>();
      this.error.set(null);
      this.submitting.set(false);
      this.method.set('totp');
      this.waiting.set(0);
      this.reason.set(reason);
      this.isOpen.set(true);
    } else if (reason === 'action-required') {
      // A deliberate re-auth that a real refused request has since joined IS
      // action-required now — something is genuinely waiting on it, and the copy
      // should say so. The reverse never applies: a deliberate request joining a
      // queue does not make the queue optional.
      this.reason.set('action-required');
    }
    this.waiting.update((count) => count + 1);
    return this.attempt.asObservable();
  }

  setMethod(method: SecondFactorMethod): void {
    if (this.submitting()) return;
    this.method.set(method);
    this.error.set(null);
  }

  /** Submit the code the operator typed. */
  submit(code: string): void {
    if (this.submitting()) return;
    const trimmed = code.trim();
    if (!trimmed) return;

    this.submitting.set(true);
    this.error.set(null);

    this.api.elevate(this.method(), trimmed).subscribe({
      next: (response) => {
        this.store.markElevated(response.elevated_at);
        // `elevate/` reports the recovery-code count exactly as `verify/` does, and it
        // was being dropped here. A re-elevation SPENDS a recovery code just as a
        // sign-in does; dropping it is how an operator reaches zero without ever
        // having been told.
        this.notices.record({
          usedRecoveryCode: response.used_recovery_code,
          recoveryCodesRemaining: response.recovery_codes_remaining,
        });
        this.settle();
      },
      error: (error: unknown) => {
        this.submitting.set(false);

        // NOT A REFUSED CODE — no answer, or the session died underneath us. Retrying
        // cannot help, so the queue is drained with a nameable failure rather than
        // left attached to a prompt that can never settle. Nothing hangs waiting for a
        // reply that is not coming.
        const failure = classifyTransportFailure(error);
        if (failure === 'unavailable') {
          // Reported HERE as well as from the interceptor, for the same reason
          // `bootstrap()` classifies directly: MOCK MODE NEVER TOUCHES `HttpClient`,
          // so no interceptor runs and the shell's outage banner — the only thing
          // that explains why this dialog just closed — would never appear in the one
          // mode this work is reviewed in. Idempotent against the interceptor in live
          // mode: same state, same request id.
          this.status.reportUnavailable(extractRequestId(error));
          this.abandon(
            new ElevationAbandonedError(
              failure,
              'The admin service did not answer, so nothing was re-authenticated.',
            ),
          );
          return;
        }
        if (failure === 'denied') {
          // A 401 here means the session ended; the error classifier has already
          // cleared it and routed to /login. A modal left open over the login form
          // would be gating an action that no longer has a session to run in.
          this.abandon(
            new ElevationAbandonedError(
              failure,
              'The session ended before re-authentication could complete.',
            ),
          );
          return;
        }

        // CASE 4. This 403 is the re-elevation ATTEMPT failing — a wrong code, the
        // wrong method for the code, a locked-out account. It is NOT "this action
        // needs elevation", and it never reopens anything: the modal is already open
        // and simply shows what the server said. The server returns ONE
        // byte-identical message for every cause by design; it is displayed verbatim.
        this.error.set(extractErrorMessage(error, 'Invalid or expired verification.'));
      },
    });
  }

  /** Escape, backdrop, or the Cancel button. Every queued request fails explicitly. */
  cancel(): void {
    this.abandon(new ElevationCancelledError());
  }

  /** Close, and fail every queued request with a reason it can be named by. */
  private abandon(error: Error): void {
    const attempt = this.attempt;
    this.reset();
    attempt?.error(error);
  }

  private settle(): void {
    const attempt = this.attempt;
    this.reset();
    attempt?.next();
    attempt?.complete();
  }

  private reset(): void {
    this.attempt = null;
    this.isOpen.set(false);
    this.submitting.set(false);
    this.error.set(null);
    this.waiting.set(0);
    this.reason.set('action-required');
  }
}
