import { inject, Injectable, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { extractErrorMessage } from '../api/error-message';
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

  /** The in-flight attempt every queued request is subscribed to, or null. */
  private attempt: Subject<void> | null = null;

  readonly isOpen = signal(false);
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
  request(): Observable<void> {
    if (!this.attempt) {
      this.attempt = new Subject<void>();
      this.error.set(null);
      this.submitting.set(false);
      this.method.set('totp');
      this.waiting.set(0);
      this.isOpen.set(true);
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
        this.settle();
      },
      error: (error: unknown) => {
        // CASE 4. This 403 is the re-elevation ATTEMPT failing — a wrong code, the
        // wrong method for the code, a locked-out account. It is NOT "this action
        // needs elevation", and it never reopens anything: the modal is already open
        // and simply shows what the server said. The server returns ONE
        // byte-identical message for every cause by design; it is displayed verbatim.
        this.submitting.set(false);
        this.error.set(extractErrorMessage(error, 'Invalid or expired verification.'));
      },
    });
  }

  /** Escape, backdrop, or the Cancel button. Every queued request fails explicitly. */
  cancel(): void {
    const attempt = this.attempt;
    this.reset();
    attempt?.error(new ElevationCancelledError());
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
  }
}
