import { DOCUMENT } from '@angular/common';
import { inject, Injectable, InjectionToken } from '@angular/core';

import { NoticeService } from '../notices/notice.service';
import { OwnerChange } from './command-owner';
import { SessionStore } from './session.store';

/**
 * Why this document can no longer act: another administrator is signed in to this
 * browser ('changed'), or the same one started a new session ('renewed').
 */
export type BoundaryKind = 'changed' | 'renewed';

export function boundaryKindFor(change: Exclude<OwnerChange, 'same'>): BoundaryKind {
  return change === 'actor-changed' ? 'changed' : 'renewed';
}

/**
 * How the document is replaced. A token rather than a direct `location.replace` call
 * so a spec can observe the crossing without unloading the test runner.
 */
export const DOCUMENT_REPLACE = new InjectionToken<(url: string) => void>('DOCUMENT_REPLACE', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return (url: string) => document.location.replace(url);
  },
});

/**
 * THE SESSION BOUNDARY (D10). Reached when this document learns that the browser's
 * admin session is not the one it was working in: the server's owner refusal, a CSRF
 * recovery or bootstrap read that names someone else, or a resume check.
 *
 * It ends the local lifecycle FIRST — queued prompts drain, every late answer stops
 * driving anything — clears the session's notices, and then REPLACES THE DOCUMENT.
 * Replacement rather than clearing a hand-kept list of stores, because that list would
 * drift the moment another root service started holding tenant data, and
 * `location.replace` rather than a push so Back cannot return to the old heap.
 *
 * A NEW SESSION OF THE SAME ADMINISTRATOR IS A BOUNDARY TOO. It is not an ordinary CSRF
 * renewal: nothing issued under the old session is replayed into the new one. The
 * operator lands on the sign-in screen with a fixed sentence, and anything they do
 * next is a new command.
 *
 * ONE CROSSING PER DOCUMENT. The document is on its way out; a second request to cross
 * has nothing left to do.
 */
@Injectable({ providedIn: 'root' })
export class SessionBoundary {
  private readonly store = inject(SessionStore);
  private readonly notices = inject(NoticeService);
  private readonly replace = inject(DOCUMENT_REPLACE);
  private crossed = false;

  /** True once this document has started crossing. */
  get hasCrossed(): boolean {
    return this.crossed;
  }

  cross(kind: BoundaryKind): void {
    if (this.crossed) return;
    this.crossed = true;
    this.store.end();
    this.notices.clear();
    // Fixed values only. The landing page renders fixed copy keyed on this word and
    // never renders the query text itself.
    this.replace(kind === 'changed' ? '/login?session=changed' : '/login?session=renewed');
  }
}
