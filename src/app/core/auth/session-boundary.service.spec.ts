import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';

import { NoticeService } from '../notices/notice.service';
import { boundaryKindFor, DOCUMENT_REPLACE, SessionBoundary } from './session-boundary.service';
import { AdminSessionResponse } from './session.model';
import { SessionStore } from './session.store';

const SESSION: AdminSessionResponse = {
  username: 'operator',
  email: 'operator@dinifyapp.com',
  issued_at: '2026-08-19T09:00:00+00:00',
  expires_at: '2026-08-19T17:00:00+00:00',
  elevated_at: null,
  server_time: '2026-08-19T12:00:00+00:00',
  command_owner: {
    version: 1,
    actor: '0a0a0a0a-0000-4000-8000-0000000000aa',
    session: '0b0b0b0b-0000-4000-8000-0000000000bb',
  },
};

describe('SessionBoundary', () => {
  let boundary: SessionBoundary;
  let store: SessionStore;
  let notices: NoticeService;
  let replaced: string[];
  /** What the store looked like at the instant the document was replaced. */
  let atReplace: { authenticated: boolean; notice: unknown } | null;

  beforeEach(() => {
    replaced = [];
    atReplace = null;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOCUMENT_REPLACE,
          useValue: (url: string) => {
            atReplace = {
              authenticated: TestBed.inject(SessionStore).isAuthenticated(),
              notice: TestBed.inject(NoticeService).notice(),
            };
            replaced.push(url);
          },
        },
      ],
    });
    boundary = TestBed.inject(SessionBoundary);
    store = TestBed.inject(SessionStore);
    notices = TestBed.inject(NoticeService);
    store.adopt(SESSION);
    notices.record({ usedRecoveryCode: true, recoveryCodesRemaining: 1 });
  });

  it('maps an owner change to the landing that names it', () => {
    expect(boundaryKindFor('actor-changed')).toBe('changed');
    expect(boundaryKindFor('session-changed')).toBe('renewed');
  });

  it('ends the lifecycle and clears the notices BEFORE replacing the document', () => {
    const before = store.lifecycle();
    const ended: number[] = [];
    store.ended$.subscribe((n) => ended.push(n));

    boundary.cross('changed');

    expect(ended).toEqual([before]);
    expect(atReplace).toEqual({ authenticated: false, notice: null });
    expect(replaced).toEqual(['/login?session=changed']);
    expect(boundary.hasCrossed).toBeTrue();
  });

  it('lands a same-administrator renewal on its own fixed sentence', () => {
    boundary.cross('renewed');
    expect(replaced).toEqual(['/login?session=renewed']);
  });

  it('crosses once per document — the document is already on its way out', () => {
    boundary.cross('renewed');
    const lifecycle = store.lifecycle();
    boundary.cross('changed');
    expect(replaced).toEqual(['/login?session=renewed']);
    expect(store.lifecycle()).toBe(lifecycle);
  });
});

describe('DOCUMENT_REPLACE', () => {
  it('REPLACES rather than pushes, so Back cannot return to the old heap', () => {
    // The production factory, run against a stand-in document so the runner survives.
    const replace = jasmine.createSpy('replace');
    const assign = jasmine.createSpy('assign');
    TestBed.configureTestingModule({
      providers: [{ provide: DOCUMENT, useValue: { location: { replace, assign } } }],
    });

    TestBed.inject(DOCUMENT_REPLACE)('/login?session=changed');

    expect(replace).toHaveBeenCalledOnceWith('/login?session=changed');
    expect(assign).not.toHaveBeenCalled();
  });
});
