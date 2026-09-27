import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of, throwError } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { NoticeService } from '../notices/notice.service';
import { AdminAuthApi, ADMIN_AUTH } from './admin-auth.api';
import { CommandNotRunError, CommandOwner, IssuedUnder } from './command-owner';
import {
  ElevationAbandonedError,
  ElevationCancelledError,
  ElevationService,
} from './elevation.service';
import { DOCUMENT_REPLACE } from './session-boundary.service';
import { AdminElevateResponse, AdminSessionResponse, SecondFactorMethod } from './session.model';
import { SessionStore } from './session.store';

const OWNER: CommandOwner = {
  version: 1,
  actor: '0a0a0a0a-0000-4000-8000-0000000000aa',
  session: '0b0b0b0b-0000-4000-8000-0000000000bb',
};
const BOUND: AdminSessionResponse = {
  username: 'operator',
  email: 'o@dinifyapp.com',
  issued_at: '2026-08-19T09:00:00+00:00',
  expires_at: '2026-08-19T17:00:00+00:00',
  elevated_at: null,
  server_time: '2026-08-19T12:00:00+00:00',
  command_owner: OWNER,
};

class StubApi implements AdminAuthApi {
  calls: { method: SecondFactorMethod; code: string }[] = [];
  /** What each attempt said it was issued under. */
  issued: IssuedUnder[] = [];
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
  elevate(
    method: SecondFactorMethod,
    code: string,
    issued: IssuedUnder,
  ): Observable<AdminElevateResponse> {
    this.calls.push({ method, code });
    this.issued.push(issued);
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
  let notices: NoticeService;
  let status: AdminServiceStatus;
  let replaced: string[];

  beforeEach(() => {
    api = new StubApi();
    replaced = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: ADMIN_AUTH, useValue: api },
        // A session boundary replaces the document; recorded here, never performed.
        { provide: DOCUMENT_REPLACE, useValue: (url: string) => replaced.push(url) },
      ],
    });
    service = TestBed.inject(ElevationService);
    store = TestBed.inject(SessionStore);
    notices = TestBed.inject(NoticeService);
    status = TestBed.inject(AdminServiceStatus);
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

  it('records the recovery-code count, which elevate/ reports and used to drop', () => {
    api.next = of({
      elevated_at: '2026-08-19T12:00:00+00:00',
      used_recovery_code: true,
      recovery_codes_remaining: 1,
    });

    service.request().subscribe({ error: () => undefined });
    service.submit('a-recovery-code');

    // A re-elevation SPENDS a recovery code exactly as a sign-in does. Dropping the
    // count here is how an operator reaches zero without ever being told.
    expect(notices.notice()?.facts).toContain('One recovery code remains.');
  });

  it('DRAINS the queue when the service does not answer, rather than hanging', () => {
    api.next = throwError(() => ({ status: 0 }));

    const errors: unknown[] = [];
    service.request().subscribe({ error: (err) => errors.push(err) });
    service.request().subscribe({ error: (err) => errors.push(err) });
    service.submit('123456');

    // A refused CODE keeps the modal open so the operator can try again. A refused
    // CONNECTION cannot be tried again into, and leaving two requests attached to a
    // prompt that can never settle is a hang.
    expect(errors.length).toBe(2);
    expect(errors.every((err) => err instanceof ElevationAbandonedError)).toBeTrue();
    expect(service.isOpen()).toBeFalse();
    // Reported here as well as from the interceptor: mock mode has no interceptor, and
    // the shell banner is the only thing that explains why the dialog just closed.
    expect(status.unavailable()).toBeTrue();
  });

  it('drains the queue when the session ended underneath it', () => {
    api.next = throwError(() => ({ status: 401, error: { detail: 'gone' } }));

    let raised: unknown = null;
    service.request().subscribe({ error: (err) => (raised = err) });
    service.submit('123456');

    // The classifier has already routed to /login. A modal left open over the login
    // form would be gating an action with no session left to run in.
    expect(raised).toBeInstanceOf(ElevationAbandonedError);
    expect(service.isOpen()).toBeFalse();
  });

  it('says WHY it is open, so a deliberate re-auth is not described as an action', () => {
    service.request('deliberate').subscribe({ error: () => undefined });
    expect(service.reason()).toBe('deliberate');

    // A real refusal joining the same attempt makes it action-required: something IS
    // waiting on it now, and the copy should say so.
    service.request().subscribe({ error: () => undefined });
    expect(service.reason()).toBe('action-required');
    expect(service.waiting()).toBe(2);
  });

  it('starts a fresh attempt after one settles', () => {
    service.request().subscribe({ complete: () => undefined });
    service.submit('123456');
    expect(service.isOpen()).toBeFalse();

    service.request().subscribe({ error: () => undefined });
    expect(service.isOpen()).toBeTrue();
    expect(service.waiting()).toBe(1);
  });

  // ── D10 ────────────────────────────────────────────────────────────────────────
  describe('D10 — one attempt, bound to the owner and lifecycle it opened under', () => {
    beforeEach(() => store.adopt(BOUND));

    it('sends the owner and lifecycle the prompt was opened under', () => {
      service.request().subscribe({ error: () => undefined });
      service.submit('123456');
      expect(api.issued).toEqual([{ owner: OWNER, lifecycle: store.lifecycle() }]);
    });

    it('Cancel, then a NEW prompt: the OLD success settles nothing, marks nothing, publishes nothing', () => {
      const old = new Subject<AdminElevateResponse>();
      api.next = old.asObservable();
      service.request().subscribe({ error: () => undefined });
      service.submit('111111');
      service.cancel();

      let settled = false;
      api.next = null;
      service.request().subscribe({ complete: () => (settled = true), error: () => (settled = true) });

      old.next({ elevated_at: '2026-08-19T12:00:00+00:00', used_recovery_code: true, recovery_codes_remaining: 1 });
      old.complete();

      expect(settled).toBeFalse();
      expect(service.isOpen()).toBeTrue();
      expect(service.submitting()).toBeFalse();
      expect(store.session()?.elevated_at).toBeNull();
      expect(notices.notice()).toBeNull();
    });

    it('Cancel, then a NEW prompt: the OLD refusal does not appear in it', () => {
      const old = new Subject<AdminElevateResponse>();
      api.next = old.asObservable();
      service.request().subscribe({ error: () => undefined });
      service.submit('000000');
      service.cancel();
      service.request().subscribe({ error: () => undefined });

      old.error({ status: 403, error: { status: 403, message: 'Invalid or expired verification.' } });

      expect(service.isOpen()).toBeTrue();
      expect(service.error()).toBeNull();
    });

    it('drains its waiters as NOT RUN the moment its lifecycle ends — and a late answer revives nothing', () => {
      const late = new Subject<AdminElevateResponse>();
      api.next = late.asObservable();
      const errors: unknown[] = [];
      let completed = 0;
      service.request().subscribe({ error: (e) => errors.push(e), complete: () => (completed += 1) });
      service.request().subscribe({ error: (e) => errors.push(e), complete: () => (completed += 1) });
      service.submit('123456');

      store.end();

      expect(errors.length).toBe(2);
      expect(errors.every((e) => e instanceof CommandNotRunError && e.reason === 'session-ended' && e.sent)).toBeTrue();
      expect(service.isOpen()).toBeFalse();

      store.adopt(BOUND);
      late.next({ elevated_at: '2026-08-19T12:00:00+00:00', used_recovery_code: true, recovery_codes_remaining: 1 });
      late.complete();
      expect(completed).toBe(0);
      expect(store.session()?.elevated_at).toBeNull();
      expect(notices.notice()).toBeNull();
    });

    it('never opens a prompt for a command whose lifecycle already ended', () => {
      const issued = { owner: OWNER, lifecycle: store.lifecycle() };
      store.end();
      let error: unknown = null;
      service.request('action-required', issued).subscribe({ error: (e) => (error = e) });
      expect(service.isOpen()).toBeFalse();
      expect((error as CommandNotRunError).reason).toBe('session-ended');
    });

    it('a submit after the lifecycle ended sends nothing', () => {
      service.request().subscribe({ error: () => undefined });
      store.end();
      service.submit('123456');
      expect(api.calls).toEqual([]);
    });

    it('closes on a not-run refusal rather than asking for the code again', () => {
      api.next = throwError(() => new CommandNotRunError('binding-unsupported', false));
      let raised: unknown = null;
      service.request().subscribe({ error: (e) => (raised = e) });
      service.submit('123456');
      expect((raised as CommandNotRunError).reason).toBe('binding-unsupported');
      expect(service.isOpen()).toBeFalse();
      expect(service.error()).toBeNull();
    });

    it('an owner refusal that reached it unclassified (the development mock) crosses the boundary', () => {
      api.next = throwError(() => ({
        status: 409,
        error: { detail: 'x', code: 'admin_command_session_changed' },
      }));
      let raised: unknown = null;
      service.request().subscribe({ error: (e) => (raised = e) });
      service.submit('123456');
      expect((raised as CommandNotRunError).reason).toBe('session-changed');
      expect(replaced).toEqual(['/login?session=renewed']);
      expect(store.isAuthenticated()).toBeFalse();
    });

    it('a lost elevate/ answer never claims re-authentication did not happen', () => {
      api.next = throwError(() => ({ status: 0 }));
      let raised: unknown = null;
      service.request().subscribe({ error: (e) => (raised = e) });
      service.submit('123456');
      const message = (raised as Error).message;
      expect(message).toContain('it is not known whether re-authentication completed');
      expect(message).not.toContain('Nothing was changed');
    });
  });
});
