import { Injectable, signal } from '@angular/core';

/**
 * An error that reached the operator as a DEFECT rather than as an outcome.
 *
 * `requestId` is the `X-Request-ID` the admin plane stamps on every response — a
 * server-generated uuid4, never read from a client header, and the correlation key
 * into the append-only `AdminAuditLog`. Showing it beside the message is what turns
 * "it broke" into a report that can be traced to a server log line.
 */
export interface Defect {
  readonly message: string;
  readonly requestId: string | null;
  /** Short machine-ish label for what class of failure this was. */
  readonly kind: 'unclassified' | 'csrf-retry-exhausted' | 'elevation-replay-exhausted';
}

@Injectable({ providedIn: 'root' })
export class DefectService {
  private readonly _current = signal<Defect | null>(null);

  /** The most recent unresolved defect, or null. */
  readonly current = this._current.asReadonly();

  report(defect: Defect): void {
    this._current.set(defect);
  }

  dismiss(): void {
    this._current.set(null);
  }
}
