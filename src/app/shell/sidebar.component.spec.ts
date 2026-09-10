import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { RouterLink, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { AdminAuthService } from '../core/auth/admin-auth.service';
import { ElevationService } from '../core/auth/elevation.service';
import { SidebarComponent } from './sidebar.component';

/**
 * THE LOGO LOCKUP IS A FULL DOCUMENT LOAD, AND THAT IS THE FRAGILE PART.
 *
 * `routerLink` is the reflex in an Angular template, and swapping it in here is a
 * one-character-looking change that silently removes the entire behaviour: a soft
 * navigation re-renders a route and refreshes nothing, while the bare href re-runs the
 * app initializer's session read and rebuilds every root service. Both spellings emit
 * an `href="/"` into the DOM, so asserting the attribute alone would NOT catch the
 * swap — the directive's absence is what has to be pinned.
 *
 * The other half is §9: the lockup must not have quietly become a sixth destination.
 * The navigation list is counted here rather than asserted in prose.
 */
describe('SidebarComponent', () => {
  let fixture: ComponentFixture<SidebarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SidebarComponent],
      providers: [
        provideRouter([]),
        { provide: AdminAuthService, useValue: { signOut: () => Promise.resolve() } },
        { provide: ElevationService, useValue: { request: () => EMPTY } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SidebarComponent);
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** The lockup link — the first anchor in the chrome, above the navigation list. */
  function lockup() {
    return fixture.debugElement.query(By.css('nav > div:first-of-type a'));
  }

  it('makes the lockup a link to the root', () => {
    expect(lockup()).withContext('the lockup is not a link at all').toBeTruthy();
    expect((lockup().nativeElement as HTMLAnchorElement).getAttribute('href')).toBe('/');
  });

  it('carries a REAL href, not a RouterLink — a soft navigation refreshes nothing', () => {
    // The load-bearing assertion. RouterLink also renders href="/", so this is the only
    // thing that tells a full document load apart from an in-app navigation.
    expect(lockup().injector.get(RouterLink, null)).toBeNull();

    // And the href is a static template attribute rather than a directive's output.
    expect(lockup().attributes['href']).toBe('/');
  });

  it('names the lockup for assistive technology', () => {
    // The mark is an SVG and 'Admin' is a bare span; without this the link announces as
    // 'Dinify' alone, which does not say where it goes.
    expect(lockup().nativeElement.getAttribute('aria-label')).toBe('Dinify Admin home');
  });

  it('renders the shared mark inside the lockup rather than a letter', () => {
    expect(lockup().nativeElement.querySelector('app-dinify-wordmark')).toBeTruthy();
    expect(el().textContent).toContain('Admin');
  });

  it('did NOT become a sixth destination — the navigation list is still five', () => {
    // §9. The lockup sits outside the list; making it an entry is the drift this counts.
    const entries = el().querySelectorAll('nav ul li a');

    expect(entries.length).toBe(5);
    expect(Array.from(entries).map((a) => a.textContent?.trim())).toEqual([
      'Home',
      'Restaurants',
      'Support',
      'Receivables',
      'Activity',
    ]);
  });
});
