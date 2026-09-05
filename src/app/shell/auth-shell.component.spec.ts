import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AuthShellComponent } from './auth-shell.component';

@Component({
  selector: 'app-auth-shell-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthShellComponent],
  template: `
    <app-auth-shell [eyebrow]="eyebrow()" [heading]="heading()" [lede]="lede()">
      <p>the projected body</p>
    </app-auth-shell>
  `,
})
class HostComponent {
  // Signals, not plain fields: the host is OnPush, so a field write would not mark it
  // dirty and `detectChanges()` would re-assert the FIRST render. The suite caught it.
  readonly eyebrow = signal<string | null>('Platform control plane');
  readonly heading = signal('Sign in');
  readonly lede = signal<string | null>('Password first, then your second factor.');
}

/**
 * THE ADMIN HALF OF THE LOCKUP IS THE SAFETY PROPERTY, NOT A FLOURISH.
 *
 * These two screens deliberately share an environment and a type hierarchy with
 * Dinify-Frontend's sign-in (see the component's own comment, and the `auth-*` note in
 * tailwind.config.js). That is only safe because the word ADMIN is on the card at the
 * moment an operator is deciding which plane to hand credentials to. It has no input
 * that can suppress it and no state that can hide it, and this is where that stays
 * true — the eyebrow and the lede are both optional, and it would be easy to let the
 * lockup drift into the same category.
 */
describe('AuthShellComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('renders the heading trio and projects the body beneath it', () => {
    expect(text()).toContain('Platform control plane');
    expect(text()).toContain('Sign in');
    expect(text()).toContain('Password first, then your second factor.');
    expect(text()).toContain('the projected body');
  });

  it('says ADMIN even with nothing but a heading', () => {
    host.eyebrow.set(null);
    host.lede.set(null);
    fixture.detectChanges();

    // Both optional lines are gone; the lockup is not one of them.
    expect(text()).not.toContain('Platform control plane');
    expect(text()).not.toContain('Password first');
    expect(text()).toContain('Admin');
  });

  it('labels the wordmark, so the lockup is announced and not merely seen', () => {
    // The mark is an inline SVG with no text nodes. Without the label a screen reader
    // reaches an unnamed graphic and the operator hears only "Admin" — which is the
    // half that does not say whose control plane this is.
    const mark = (fixture.nativeElement as HTMLElement).querySelector('svg[role="img"]');

    expect(mark?.getAttribute('aria-label')).toBe('Dinify');
  });

  it('draws the mark from currentColor, so it tracks the accent token', () => {
    // The source asset fills the emblem with a literal brand-red hex. Carrying that
    // across would put a colour in a component, and would silently stop tracking
    // --admin-accent through §16's pending brand-red review. The token gate cannot see
    // an attribute that was simply never added, so it is asserted here instead.
    const paths = (fixture.nativeElement as HTMLElement).querySelectorAll('svg path');

    expect(paths.length).toBeGreaterThan(0);
    for (const path of Array.from(paths)) {
      expect(path.getAttribute('fill')).toBeNull();
      expect(path.getAttribute('style')).toBeNull();
    }
  });
});
