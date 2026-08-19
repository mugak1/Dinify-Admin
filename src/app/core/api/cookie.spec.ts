import { CSRF_COOKIE_NAME } from './api.constants';
import { readCookie } from './cookie';

describe('readCookie', () => {
  it('reads a cookie by exact name', () => {
    expect(readCookie(CSRF_COOKIE_NAME, `${CSRF_COOKIE_NAME}=abc123`)).toBe('abc123');
  });

  it('finds the cookie among others, whatever the spacing', () => {
    const jar = `first=1; ${CSRF_COOKIE_NAME}=token;last=3`;
    expect(readCookie(CSRF_COOKIE_NAME, jar)).toBe('token');
  });

  /**
   * The reason this is a named function rather than an `indexOf`. `document.cookie`
   * is one flat string and values are largely unconstrained, so another cookie can
   * carry our cookie's NAME inside its VALUE — a substring search then returns the
   * attacker-influenced fragment, and the SPA echoes it as its CSRF token.
   */
  it('is not fooled by another cookie whose VALUE contains the name', () => {
    const jar = `analytics=junk-${CSRF_COOKIE_NAME}=stolen; other=2`;
    expect(readCookie(CSRF_COOKIE_NAME, jar)).toBeNull();
  });

  it('is not fooled by a cookie whose name merely ends with ours', () => {
    expect(readCookie(CSRF_COOKIE_NAME, `x-${CSRF_COOKIE_NAME}=nope`)).toBeNull();
  });

  it('is not fooled by a cookie whose name merely starts with ours', () => {
    expect(readCookie(CSRF_COOKIE_NAME, `${CSRF_COOKIE_NAME}-extra=nope`)).toBeNull();
  });

  it('keeps a value that itself contains "="', () => {
    expect(readCookie('a', 'a=b=c=d')).toBe('b=c=d');
  });

  it('decodes a percent-encoded value and survives a malformed one', () => {
    expect(readCookie('a', 'a=one%20two')).toBe('one two');
    // A bad escape must not throw out of an interceptor.
    expect(readCookie('a', 'a=%E0%A4%A')).toBe('%E0%A4%A');
  });

  it('returns null for an absent cookie or an empty jar', () => {
    expect(readCookie(CSRF_COOKIE_NAME, 'other=1')).toBeNull();
    expect(readCookie(CSRF_COOKIE_NAME, '')).toBeNull();
  });

  /**
   * The `__Host-` prefix constrains how the SERVER may set the cookie (Secure,
   * Path=/, no Domain). To the client it is just part of the name, and this pins that
   * no special handling crept in.
   */
  it('treats the __Host- prefix as ordinary name characters', () => {
    expect(CSRF_COOKIE_NAME.startsWith('__Host-')).toBeTrue();
    expect(readCookie(CSRF_COOKIE_NAME, `dinify_admin_csrftoken=wrong; ${CSRF_COOKIE_NAME}=right`))
      .toBe('right');
  });
});
