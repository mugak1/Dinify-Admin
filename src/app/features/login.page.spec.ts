import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';

import { AdminAuthService, PostVerifyReadError } from '../core/auth/admin-auth.service';
import { AdminLoginResponse, AdminVerifyResponse } from '../core/auth/session.model';
import { LoginPage } from './login.page';

/** Not an `HttpErrorResponse`: the page must classify by duck-typing, like everything. */
class WireError extends Error {
  constructor(
    readonly status: number,
    readonly error: unknown = null,
  ) {
    super(`HTTP ${status}`);
  }
}

const VERIFIED: AdminVerifyResponse = {
  username: 'operator',
  expires_at: '2026-08-19T17:00:00+00:00',
  used_recovery_code: false,
  lockout_cleared: false,
  recovery_codes_remaining: 8,
};

class StubAuth {
  loginAnswer: () => Promise<AdminLoginResponse> = () =>
    Promise.resolve({ second_factor_required: true, recovery_code_required: false });
  verifyAnswer: () => Promise<AdminVerifyResponse> = () => Promise.resolve(VERIFIED);

  login(): Promise<AdminLoginResponse> {
    return this.loginAnswer();
  }
  verify(): Promise<AdminVerifyResponse> {
    return this.verifyAnswer();
  }
}

/**
 * A DEAD BACKEND MUST NOT PRESENT AS A WRONG PASSWORD.
 *
 * When nothing answers, `extractErrorMessage` has nothing to read and falls back to
 * the uniform "Invalid credentials." — the disclosure control speaking confidently
 * about a situation it knows nothing about. These specs pin the branch that stops it.
 */
describe('LoginPage', () => {
  let fixture: ComponentFixture<LoginPage>;
  let page: LoginPage;
  let auth: StubAuth;
  let router: jasmine.SpyObj<Router>;

  beforeEach(async () => {
    auth = new StubAuth();
    router = jasmine.createSpyObj<Router>('Router', ['navigate', 'navigateByUrl']);
    router.navigate.and.resolveTo(true);
    router.navigateByUrl.and.resolveTo(true);

    await TestBed.configureTestingModule({
      imports: [LoginPage],
      providers: [
        { provide: AdminAuthService, useValue: auth },
        { provide: Router, useValue: router },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginPage);
    page = fixture.componentInstance;
    fixture.detectChanges();
  });

  /** Protected members, reached the documented way rather than by widening them. */
  function submitCredentials(): Promise<void> {
    return (page as unknown as { submitCredentials(): Promise<void> }).submitCredentials();
  }
  function submitSecondFactor(): Promise<void> {
    return (page as unknown as { submitSecondFactor(): Promise<void> }).submitSecondFactor();
  }
  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function reachSecondFactor(): Promise<void> {
    await submitCredentials();
    fixture.detectChanges();
  }

  function el<T extends HTMLElement>(selector: string): T | null {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  }

  /** Two REAL refusals at step 2 return the operator to step 1. */
  async function failSecondFactorTwice(): Promise<void> {
    auth.verifyAnswer = () =>
      Promise.reject(new WireError(401, { status: 401, message: 'Invalid or expired verification.' }));
    await submitSecondFactor();
    fixture.detectChanges();
    await submitSecondFactor();
    fixture.detectChanges();
  }

  it('says the control plane is unreachable rather than "Invalid credentials."', async () => {
    auth.loginAnswer = () => Promise.reject(new WireError(0));

    await submitCredentials();
    fixture.detectChanges();

    expect(text()).toContain('The admin control plane is not answering');
    expect(text()).not.toContain('Invalid credentials.');
  });

  it('does not clear the password because the network dropped', async () => {
    auth.loginAnswer = () => Promise.reject(new WireError(502));
    (page as unknown as { password: string }).password = 'correct horse';

    await submitCredentials();

    // Nothing was rejected, so nothing typed should behave as though it was.
    expect((page as unknown as { password: string }).password).toBe('correct horse');
  });

  it('still shows the server verbatim when the server actually answered', async () => {
    auth.loginAnswer = () =>
      Promise.reject(new WireError(401, { status: 401, message: 'Invalid credentials.' }));

    await submitCredentials();
    fixture.detectChanges();

    // The uniform failure message is a disclosure control and is displayed as-is.
    expect(text()).toContain('Invalid credentials.');
  });

  it('does NOT spend the retry budget on an unreachable service', async () => {
    await reachSecondFactor();
    auth.verifyAnswer = () => Promise.reject(new WireError(0));

    await submitSecondFactor();
    fixture.detectChanges();
    await submitSecondFactor();
    fixture.detectChanges();

    // Two REAL failures return the operator to step 1, because the challenge is
    // probably dead. Two outages must not: the challenge is untouched and still alive,
    // and counting them would throw away a perfectly good five-minute window.
    expect(text()).toContain('Six-digit code');
    expect(text()).toContain('The admin control plane is not answering');
  });

  it('does not clear the typed code on an unreachable service', async () => {
    await reachSecondFactor();
    (page as unknown as { code: string }).code = '123456';
    auth.verifyAnswer = () => Promise.reject(new WireError(0));

    await submitSecondFactor();

    expect((page as unknown as { code: string }).code).toBe('123456');
  });

  it('still counts a genuine refusal, and starts over after the second one', async () => {
    await reachSecondFactor();
    auth.verifyAnswer = () =>
      Promise.reject(new WireError(401, { status: 401, message: 'Invalid or expired verification.' }));

    await submitSecondFactor();
    fixture.detectChanges();
    expect(text()).toContain('Six-digit code');

    await submitSecondFactor();
    fixture.detectChanges();

    // Back to step 1: the challenge is probably expired or out of attempts.
    expect(text()).toContain('Sign in');
    expect(text()).toContain('Password');
  });

  it('routes a live session with a dead service to the unavailable view', async () => {
    await reachSecondFactor();
    auth.verifyAnswer = () => Promise.reject(new PostVerifyReadError('unavailable', 'req-9'));

    await submitSecondFactor();

    // The factor was ACCEPTED and an eight-hour cookie is live. Sending them back to a
    // sign-in form asks them to fix something that is not broken; the unavailable
    // view's retry re-reads THIS session and lands them in the shell.
    expect(router.navigate).toHaveBeenCalledWith(['/unavailable'], { replaceUrl: true });
  });

  it('asks for a fresh sign-in when the service answered but withheld the session', async () => {
    await reachSecondFactor();
    auth.verifyAnswer = () => Promise.reject(new PostVerifyReadError('denied', null));

    await submitSecondFactor();
    fixture.detectChanges();

    expect(text()).toContain('Signed in, but the session could not be read back.');
    // Never back to step 2: the challenge cookie was cleared by the successful verify,
    // so a retry there can only fail.
    expect(text()).toContain('Password');
  });

  /**
   * THIS SCREEN SHARES ITS LOOK WITH THE RESTAURANT PORTAL'S SIGN-IN, DELIBERATELY.
   *
   * §16 makes visual distinctness a SAFETY requirement, and the redesign moved where
   * that distinctness lives on the two signed-out screens: from an environment nobody
   * could confuse to WORDS an operator reads before typing. Three carry it — the ADMIN
   * lockup, the eyebrow naming the plane, and the route title. If a later tidy-up drops
   * one for balance, an operator with both portals open loses the cue at the exact
   * moment it matters, so the two this component owns are pinned here.
   */
  it('names the plane on the sign-in step, beside the ADMIN lockup', () => {
    expect(text()).toContain('Admin');
    expect(text()).toContain('Platform control plane');
  });

  it('masks the password until asked, and re-masks on a return to step 1', async () => {
    expect(el<HTMLInputElement>('input#password')?.type).toBe('password');

    el<HTMLButtonElement>('[aria-label="Show password"]')?.click();
    fixture.detectChanges();
    expect(el<HTMLInputElement>('input#password')?.type).toBe('text');

    await reachSecondFactor();
    await failSecondFactorTwice();

    // Back on step 1 after a challenge died. Carrying the reveal across would leave a
    // password legible on a screen the operator did not choose to be on.
    expect(el<HTMLInputElement>('input#password')?.type).toBe('password');
  });

  /**
   * "CAREFUL, NOTHING ANSWERED" AND "WHAT YOU TYPED WAS REFUSED" MUST NOT LOOK ALIKE.
   *
   * The whole reason the transport check sits above the message path is that an outage
   * answered as a refusal costs the operator an afternoon. Rendering the two in one
   * treatment gives that back visually, so the hues are pinned as well as the copy:
   * §16 reserves the danger token for a refusal and the warning token for careful.
   */
  it('renders an outage in the warning treatment, never the refusal one', async () => {
    auth.loginAnswer = () => Promise.reject(new WireError(0));

    await submitCredentials();
    fixture.detectChanges();

    const notice = el('[role="alert"]');
    expect(notice?.textContent).toContain('The admin control plane is not answering');
    expect(notice?.className).toContain('admin-warning');
    expect(notice?.className).not.toContain('text-admin-danger');
  });

  it('renders a refusal in the danger treatment, and adds nothing to it', async () => {
    auth.loginAnswer = () =>
      Promise.reject(new WireError(401, { status: 401, message: 'Invalid credentials.' }));

    await submitCredentials();
    fixture.detectChanges();

    const refusal = el('[role="alert"]');
    expect(refusal?.className).toContain('text-admin-danger');
    expect(refusal?.className).not.toContain('admin-warning');
    // VERBATIM. The uniform message is a disclosure control, so the styled block that
    // carries it must not have grown a prefix, a severity word or a hint around it.
    expect(refusal?.textContent?.trim()).toBe('Invalid credentials.');
  });
});
