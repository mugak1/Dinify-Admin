import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminAuthApi, ADMIN_AUTH } from './admin-auth.api';
import { ElevationCancelledError, ElevationService } from './elevation.service';
import { AdminElevateResponse, SecondFactorMethod } from './session.model';
import { SessionStore } from './session.store';

class StubApi implements AdminAuthApi {
  calls: { method: SecondFactorMethod; code: string }[] = [];
  next: Observable<AdminElevateResponse> | null = null;

  login(): Observable<never> {
    throw new Error('not used');
  }
  verify(): Observable<never> {
    throw new Error('not used');
  }
  logout(): Observable<void> {
    return of(undefined);
  }
  readSession(): Observable<never> {
    throw new Error('not used');
  }
  elevate(method: SecondFactorMethod, code: string): Observable<AdminElevateResponse> {
    this.calls.push({ method, code });
    return (
      this.next ??
      of({ elevated_at: '2026-08-19T12:00:00+00:00', used_recovery_code: false, recovery_codes_remaining: 8 })
    );
  }
}

describe('ElevationService', () => {
  let service: ElevationService;
  let api: StubApi;
  let store: SessionStore;

  beforeEach(() => {
    api = new StubApi();
    TestBed.configureTestingModule({ providers: [{ provide: ADMIN_AUTH, useValue: api }] });
    service = TestBed.inject(ElevationService);
    store = TestBed.inject(SessionStore);
  });

  it('opens on the first request and counts every waiter', () => {
    expect(service.isOpen()).toBeFalse();

    service.request().subscribe({ error: () => undefined });
    service.request().subscribe({ error: () => undefined });
    service.request().subscribe({ error: () => undefined });

    // A SINGLETON WITH A QUEUE: one modal, three requests behind it.
    expect(service.isOpen()).toBeTrue();
    expect(service.waiting()).toBe(3);
  });

  it('completes every waiter once, on a single successful elevation', () => {
    let completions = 0;
    service.request().subscribe({ complete: () => (completions += 1) });
    service.request().subscribe({ complete: () => (completions += 1) });

    service.submit('123456');

    expect(api.calls.length).toBe(1);
    expect(completions).toBe(2);
    expect(service.isOpen()).toBeFalse();
    expect(service.waiting()).toBe(0);
  });

  it('sends the method EXPLICITLY, and never infers it from the code shape', () => {
    service.request().subscribe({ error: () => undefined });
    service.setMethod('recovery');
    service.submit('AbCdEfGhIjKlMnOpQrStUv');

    expect(api.calls[0]).toEqual({ method: 'recovery', code: 'AbCdEfGhIjKlMnOpQrStUv' });
  });

  it('records the fresh elevation on the session', () => {
    store.adopt({
      username: 'operator',
      email: 'o@dinifyapp.com',
      issued_at: '2026-08-19T09:00:00+00:00',
      expires_at: '2026-08-19T17:00:00+00:00',
      elevated_at: null,
      server_time: '2026-08-19T12:00:00+00:00',
    });
    expect(store.elevationStale()).toBeTrue();

    service.request().subscribe({ error: () => undefined });
    service.submit('123456');

    expect(store.session()?.elevated_at).toBe('2026-08-19T12:00:00+00:00');
  });

  it('keeps the dialog open on a refused code and shows the server message verbatim', () => {
    api.next = throwError(() => ({
      status: 403,
      error: { status: 403, message: 'Invalid or expired verification.' },
    }));

    let settled = false;
    service.request().subscribe({ complete: () => (settled = true), error: () => (settled = true) });
    service.submit('000000');

    // CASE 4: the re-elevation ATTEMPT failed. The waiters keep waiting; the operator
    // gets another go without losing what they were doing.
    expect(settled).toBeFalse();
    expect(service.isOpen()).toBeTrue();
    expect(service.submitting()).toBeFalse();
    expect(service.error()).toBe('Invalid or expired verification.');
  });

  it('recovers after a refused code and can then succeed', () => {
    api.next = throwError(() => ({ status: 403, error: { status: 403, message: 'nope' } }));
    let completed = false;
    service.request().subscribe({ complete: () => (completed = true) });
    service.submit('000000');

    api.next = null;
    service.submit('123456');

    expect(completed).toBeTrue();
    expect(api.calls.length).toBe(2);
  });

  it('fails every waiter with an explicit cancelled state', () => {
    const errors: unknown[] = [];
    service.request().subscribe({ error: (err) => errors.push(err) });
    service.request().subscribe({ error: (err) => errors.push(err) });

    service.cancel();

    // Nothing hangs silently: each queued request gets a nameable failure.
    expect(errors.length).toBe(2);
    expect(errors.every((err) => err instanceof ElevationCancelledError)).toBeTrue();
    expect(service.isOpen()).toBeFalse();
  });

  it('ignores a second submit while one is in flight', () => {
    const gate = new Subject<AdminElevateResponse>();
    api.next = gate.asObservable();

    service.request().subscribe({ error: () => undefined });
    service.submit('111111');
    service.submit('222222');

    expect(api.calls.length).toBe(1);
    gate.complete();
  });

  it('starts a fresh attempt after one settles', () => {
    service.request().subscribe({ complete: () => undefined });
    service.submit('123456');
    expect(service.isOpen()).toBeFalse();

    service.request().subscribe({ error: () => undefined });
    expect(service.isOpen()).toBeTrue();
    expect(service.waiting()).toBe(1);
  });
});
