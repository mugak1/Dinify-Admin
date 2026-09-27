import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, Subject } from 'rxjs';

import { AdminServiceStatus } from '../api/service-status';
import { AdminAuthApi, ADMIN_AUTH } from './admin-auth.api';
import { CommandOwner } from './command-owner';
import { DOCUMENT_REPLACE } from './session-boundary.service';
import { SessionContinuityService } from './session-continuity.service';
import { AdminSessionResponse } from './session.model';
import { SessionStore } from './session.store';

const OWNER: CommandOwner = {
  version: 1,
  actor: '0a0a0a0a-0000-4000-8000-0000000000aa',
  session: '0b0b0b0b-0000-4000-8000-0000000000bb',
};
const BOUND: AdminSessionResponse = {
  username: 'operator',
  email: 'operator@dinifyapp.com',
  issued_at: '2026-08-19T09:00:00+00:00',
  expires_at: '2026-08-19T17:00:00+00:00',
  elevated_at: null,
  server_time: '2026-08-19T12:00:00+00:00',
  command_owner: OWNER,
};
const RENEWED_SESSION = '0d0d0d0d-0000-4000-8000-0000000000dd';
const RENEWED: AdminSessionResponse = {
  ...BOUND,
  command_owner: { ...OWNER, session: RENEWED_SESSION },
};
const SOMEONE_ELSE: AdminSessionResponse = {
  ...BOUND,
  username: 'someone.else',
  command_owner: { ...OWNER, actor: '0c0c0c0c-0000-4000-8000-0000000000cc' },
};

/** Each `readSession()` is a Subject the spec answers when it chooses. */
class StubApi implements Partial<AdminAuthApi> {
  readonly reads: Subject<AdminSessionResponse>[] = [];
  readSession(): Observable<AdminSessionResponse> {
    const read = new Subject<AdminSessionResponse>();
    this.reads.push(read);
    return read;
  }
}

function answer(read: Subject<AdminSessionResponse>, session: AdminSessionResponse): void {
  read.next(session);
  read.complete();
}

/**
 * RESUME REVALIDATION. Everything below drives the service directly; the event wiring
 * is exercised with SYNTHETIC events, which prove the listeners are attached and torn
 * down — not how a real browser fires them on a real tab switch or bfcache restore.
 */
describe('SessionContinuityService', () => {
  let continuity: SessionContinuityService;
  let store: SessionStore;
  let status: AdminServiceStatus;
  let api: StubApi;
  let router: jasmine.SpyObj<Router>;
  let replaced: string[];

  beforeEach(() => {
    api = new StubApi();
    replaced = [];
    router = jasmine.createSpyObj<Router>('Router', ['navigate'], { url: '/restaurants/abc' });
    router.navigate.and.resolveTo(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: ADMIN_AUTH, useValue: api },
        { provide: Router, useValue: router },
        { provide: DOCUMENT_REPLACE, useValue: (url: string) => replaced.push(url) },
      ],
    });
    continuity = TestBed.inject(SessionContinuityService);
    store = TestBed.inject(SessionStore);
    status = TestBed.inject(AdminServiceStatus);
    store.adopt(BOUND);
  });

  it('shows sensitive content only for a signed-in, owner-bound, confirmed document', () => {
    expect(continuity.sensitiveHidden()).toBeFalse();

    store.end();
    expect(continuity.sensitiveHidden()).withContext('no session').toBeTrue();

    const legacy: Record<string, unknown> = { ...BOUND };
    delete legacy['command_owner'];
    store.adopt(legacy as unknown as AdminSessionResponse);
    expect(continuity.state()).toBe('confirmed');
    expect(continuity.sensitiveHidden()).withContext('no owner to confirm against').toBeTrue();
  });

  it('hides SYNCHRONOUSLY on hide or resume, before anything is sent', () => {
    continuity.markUnconfirmed();
    expect(continuity.sensitiveHidden()).toBeTrue();
    expect(api.reads.length).toBe(0);

    continuity.revalidate();
    expect(continuity.sensitiveHidden()).toBeTrue();
    expect(api.reads.length).toBe(1);
  });

  it('confirms and shows again when the read names the SAME owner', () => {
    continuity.revalidate();
    answer(api.reads[0], BOUND);
    expect(continuity.state()).toBe('confirmed');
    expect(continuity.sensitiveHidden()).toBeFalse();
    expect(replaced).toEqual([]);
  });

  it('coalesces: one read in flight and one queued, however many events arrive', () => {
    for (let i = 0; i < 5; i += 1) continuity.revalidate();
    expect(api.reads.length).toBe(1);

    answer(api.reads[0], BOUND);
    // The first read was issued before the later events: it confirms NOTHING about
    // them, so the content stays hidden and the ONE queued read goes out.
    expect(continuity.sensitiveHidden()).toBeTrue();
    expect(api.reads.length).toBe(2);

    answer(api.reads[1], BOUND);
    expect(continuity.sensitiveHidden()).toBeFalse();
    expect(api.reads.length).toBe(2);
  });

  it('an older check never un-hides content over a newer event', () => {
    continuity.revalidate();
    continuity.markUnconfirmed();
    answer(api.reads[0], BOUND);
    expect(continuity.sensitiveHidden()).toBeTrue();
  });

  it('crosses the boundary on a NEW SESSION of the same administrator, and adopts nothing', () => {
    continuity.revalidate();
    answer(api.reads[0], RENEWED);
    expect(replaced).toEqual(['/login?session=renewed']);
    expect(store.isAuthenticated()).toBeFalse();
  });

  it('crosses the boundary on a DIFFERENT administrator', () => {
    continuity.revalidate();
    answer(api.reads[0], SOMEONE_ELSE);
    expect(replaced).toEqual(['/login?session=changed']);
  });

  it('UNAVAILABLE IS NOT DENIED: signed in, hidden, and the existing outage recovery offered', () => {
    continuity.revalidate();
    api.reads[0].error({ status: 0 });

    expect(store.isAuthenticated()).toBeTrue();
    expect(continuity.state()).toBe('unconfirmed');
    expect(continuity.sensitiveHidden()).toBeTrue();
    expect(status.unavailable()).toBeTrue();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
  });

  it('a 200 that is not a session is unavailable too, not a confirmation', () => {
    continuity.revalidate();
    api.reads[0].next({ nonsense: true } as unknown as AdminSessionResponse);
    expect(continuity.sensitiveHidden()).toBeTrue();
    expect(status.unavailable()).toBeTrue();
  });

  it('a genuine denial reaching it unclassified (the development mock) ends the session', () => {
    continuity.revalidate();
    api.reads[0].error({ status: 401, error: { detail: 'gone' } });
    expect(store.isAuthenticated()).toBeFalse();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], {
      queryParams: { returnUrl: '/restaurants/abc' },
      replaceUrl: true,
    });
  });

  it('a check in flight when the lifecycle ends answers nothing — no boundary, no denial, no outage', () => {
    continuity.revalidate();
    continuity.revalidate();
    store.end();
    answer(api.reads[0], SOMEONE_ELSE);
    expect(replaced).toEqual([]);
    expect(api.reads.length).withContext('the queued check went with the lifecycle').toBe(1);

    store.adopt(BOUND);
    expect(continuity.state()).toBe('confirmed');
  });

  // ── AN OLDER READ NEVER OVERTURNS A NEWER ONE (Codex review of #37) ───────────────
  // Reads are sent in issue order and each carries the cookie the browser held when it
  // was SENT, so one that settles after a newer read was applied describes an earlier
  // moment. It may agree with what is held; it may not report a change or withdraw the
  // capability on the strength of that moment.
  describe('reads that settle out of order', () => {
    const LEGACY: AdminSessionResponse = (() => {
      const legacy: Record<string, unknown> = { ...BOUND };
      delete legacy['command_owner'];
      return legacy as unknown as AdminSessionResponse;
    })();

    it('an older read naming another SESSION after a newer one was adopted is superseded — no boundary', () => {
      store.end();
      const older = store.issueTicket();
      const newer = store.issueTicket();
      expect(continuity.apply(newer, continuity.epoch(), RENEWED)).toBe('adopted');
      expect(continuity.apply(older, continuity.epoch(), BOUND)).toBe('superseded');
      expect(replaced).toEqual([]);
      expect(store.owner()?.session).toBe(RENEWED_SESSION);
    });

    it('an older read naming another ADMINISTRATOR after a newer confirmation is superseded — no boundary', () => {
      const older = store.issueTicket();
      const newer = store.issueTicket();
      expect(continuity.apply(newer, continuity.epoch(), BOUND)).toBe('same');
      expect(continuity.apply(older, continuity.epoch(), SOMEONE_ELSE)).toBe('superseded');
      expect(replaced).toEqual([]);
      expect(store.username()).toBe('operator');
    });

    it('an older read publishing NO owner cannot withdraw the capability a newer one established', () => {
      store.end();
      const older = store.issueTicket();
      const newer = store.issueTicket();
      expect(continuity.apply(newer, continuity.epoch(), BOUND)).toBe('adopted');
      expect(continuity.apply(older, continuity.epoch(), LEGACY)).toBe('superseded');
      expect(store.binding()).toBe('supported');
      expect(store.owner()).toEqual(OWNER);
    });

    it('a NEWER read that stops publishing the owner still withdraws it — and an older one cannot cross afterwards', () => {
      const older = store.issueTicket();
      const newer = store.issueTicket();
      expect(continuity.apply(newer, continuity.epoch(), LEGACY)).toBe('unbound');
      expect(store.binding()).toBe('unsupported');
      expect(continuity.apply(older, continuity.epoch(), SOMEONE_ELSE)).toBe('superseded');
      expect(replaced).toEqual([]);
    });

    it('CONTROL — an older read that AGREES is still the same owner, and changes no newer field', () => {
      const older = store.issueTicket();
      const newer = store.issueTicket();
      const later = { ...BOUND, server_time: '2026-08-19T12:05:00+00:00' };
      expect(continuity.apply(newer, continuity.epoch(), later)).toBe('same');
      const anchored = store.serverNowMs();
      expect(continuity.apply(older, continuity.epoch(), BOUND)).toBe('same');
      // Re-anchored on the older read, the server clock would fall back five minutes.
      expect(anchored! - store.serverNowMs()!).withContext('the older read re-anchored nothing').toBeLessThan(1000);
    });

    it('CONTROL — a NEWER read naming another session still crosses the boundary', () => {
      const older = store.issueTicket();
      const newer = store.issueTicket();
      expect(continuity.apply(older, continuity.epoch(), BOUND)).toBe('same');
      expect(continuity.apply(newer, continuity.epoch(), RENEWED)).toBe('session-changed');
      expect(replaced).toEqual(['/login?session=renewed']);
    });
  });

  it('a signed-out document asks nothing', () => {
    store.end();
    continuity.revalidate();
    expect(api.reads.length).toBe(0);
  });

  describe('event wiring (SYNTHETIC events — attachment and teardown, not native browser behaviour)', () => {
    let stop: () => void;
    beforeEach(() => (stop = continuity.start()));
    afterEach(() => stop());

    it('focus and pageshow revalidate; pagehide hides', () => {
      window.dispatchEvent(new Event('focus'));
      expect(api.reads.length).toBe(1);
      answer(api.reads[0], BOUND);

      window.dispatchEvent(new Event('pagehide'));
      expect(continuity.sensitiveHidden()).toBeTrue();
      window.dispatchEvent(new Event('pageshow'));
      expect(api.reads.length).toBe(2);
    });

    it('visibilitychange hides when hidden and revalidates when visible', () => {
      const visibility = spyOnProperty(Document.prototype, 'visibilityState', 'get');
      visibility.and.returnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(continuity.sensitiveHidden()).toBeTrue();
      expect(api.reads.length).toBe(0);

      visibility.and.returnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(api.reads.length).toBe(1);
    });

    it('its teardown removes every listener', () => {
      stop();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('pagehide'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(api.reads.length).toBe(0);
      expect(continuity.sensitiveHidden()).toBeFalse();
      stop = () => undefined;
    });
  });
});
