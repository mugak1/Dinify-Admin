import { TestBed } from '@angular/core/testing';

import { NoticeService } from './notice.service';

describe('NoticeService', () => {
  let notices: NoticeService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    notices = TestBed.inject(NoticeService);
  });

  it('says nothing when there is nothing to say', () => {
    expect(notices.notice()).toBeNull();

    notices.record({ usedRecoveryCode: false, recoveryCodesRemaining: 8 });

    // Eight codes left and no lockout is not news, and a channel that speaks when
    // there is no news is one the operator stops reading.
    expect(notices.notice()).toBeNull();
  });

  it('warns while recovery codes are low, and counts them exactly', () => {
    notices.record({ usedRecoveryCode: true, recoveryCodesRemaining: 2 });

    const notice = notices.notice();
    expect(notice?.title).toBe('Recovery codes are running low');
    expect(notice?.urgent).toBeTrue();
    expect(notice?.facts).toContain('2 recovery codes remain.');
    expect(notice?.action).toContain('reset_platform_admin_totp');
  });

  it('COMPOSES two conditions into one notice rather than stacking two', () => {
    notices.record({ lockoutCleared: true, usedRecoveryCode: true, recoveryCodesRemaining: 1 });

    const notice = notices.notice();
    // One notice. Three distinct facts, one line each — never flattened into a single
    // sentence, which is what the console.warn it replaces used to do.
    expect(notice?.facts).toEqual([
      'This sign-in cleared the account lockout.',
      'A recovery code was used. It cannot be used again.',
      'One recovery code remains.',
    ]);
  });

  it('reports a cleared lockout on its own, without pretending it is urgent', () => {
    notices.record({ lockoutCleared: true, usedRecoveryCode: true, recoveryCodesRemaining: 9 });

    const notice = notices.notice();
    // "Something was fixed" and "a resource is running out" are different facts.
    expect(notice?.title).toBe('Account lockout cleared');
    expect(notice?.urgent).toBeFalse();
    expect(notice?.action).toBeNull();
  });

  it('stays dismissed, and comes back on the next sign-in while the condition holds', () => {
    notices.record({ usedRecoveryCode: true, recoveryCodesRemaining: 2 });
    notices.dismiss();
    expect(notices.notice()).toBeNull();

    notices.record({ usedRecoveryCode: false, recoveryCodesRemaining: 2 });

    // Reading it once is not acting on it. Running out with a lost authenticator means
    // a command on the box, which is worth several warnings before it arrives.
    expect(notices.notice()).not.toBeNull();
  });

  it('does not resurrect a dismissed notice for a routine re-elevation', () => {
    notices.record({ lockoutCleared: true, usedRecoveryCode: false, recoveryCodesRemaining: 9 });
    notices.dismiss();

    notices.record({ usedRecoveryCode: false, recoveryCodesRemaining: 9 });

    expect(notices.notice()).toBeNull();
  });

  it('warns after a re-elevation that spent a code, not just after sign-in', () => {
    // `elevate/` reports the count exactly as `verify/` does, and it used to be
    // dropped on the floor — which is how an operator reaches zero unwarned.
    notices.record({ usedRecoveryCode: true, recoveryCodesRemaining: 0 });

    expect(notices.notice()?.facts).toContain('No recovery codes remain.');
  });

  it('forgets everything on sign-out', () => {
    notices.record({ lockoutCleared: true, usedRecoveryCode: true, recoveryCodesRemaining: 1 });
    notices.clear();

    // These are facts about ONE session and must not greet the next operator to sign
    // in on this machine.
    expect(notices.notice()).toBeNull();
  });
});
