import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DinifyWordmarkComponent, WordmarkTone } from './dinify-wordmark.component';

@Component({
  selector: 'app-dinify-wordmark-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DinifyWordmarkComponent],
  template: `<app-dinify-wordmark class="h-5" [tone]="tone()" />`,
})
class HostComponent {
  // A signal, not a plain field: the host is OnPush, so a field write would not mark it
  // dirty and `detectChanges()` would re-assert the FIRST render. The auth-shell suite
  // caught that the hard way.
  readonly tone = signal<WordmarkTone>('ink');
}

/**
 * WHAT IS PINNED HERE IS WHAT THE TOKEN GATE CANNOT SEE.
 *
 * `check-design-tokens.mjs` fails on a colour that is WRITTEN. This component's whole
 * design is that none is — the mark carries no fill of its own and reads
 * `--admin-accent` and the host's tone instead — so the gate would pass just as
 * happily on a version that had quietly regained the source asset's brand-red hex, or
 * lost `currentColor` and fallen back to SVG's default black (invisible on the dark
 * sidebar, and off-brand on the card). An attribute that was never added is exactly
 * what a source scanner cannot notice, so it is asserted.
 */
describe('DinifyWordmarkComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  /** [0] is the emblem, [1] the logotype. Their order is the mark's reading order. */
  function groups(): Element[] {
    return Array.from(el().querySelectorAll('svg > g'));
  }

  function setTone(tone: WordmarkTone): void {
    host.tone.set(tone);
    fixture.detectChanges();
  }

  it('labels the mark, so the lockup is announced and not merely seen', () => {
    // Inline SVG has no text nodes. Unlabelled, a screen reader reaches an unnamed
    // graphic and the operator hears only "Admin" — the half that does not say whose
    // control plane this is.
    const mark = el().querySelector('svg[role="img"]');

    expect(mark?.getAttribute('aria-label')).toBe('Dinify');
  });

  it('spells no colour on any path', () => {
    const paths = el().querySelectorAll('svg path');

    expect(paths.length).toBe(7);
    for (const path of Array.from(paths)) {
      expect(path.getAttribute('fill')).toBeNull();
      expect(path.getAttribute('style')).toBeNull();
    }
  });

  it('paints both halves from currentColor rather than SVG default black', () => {
    // Without this the mark still renders — in black, which is invisible against the
    // chrome and off-brand on the card. A silent failure, so it gets an assertion.
    for (const group of groups()) {
      expect(group.getAttribute('fill')).toBe('currentColor');
    }
  });

  it('fits the whole mark inside the viewBox, descender included', () => {
    // The box this was extracted with ended at x=895 while the "y" reaches 898, so the
    // mark had been rendering with its tail shaved off. Sub-pixel at 20px, and still
    // wrong — and invisible to every other gate here, since a clipped SVG throws
    // nothing and renders happily. Measured, so a future re-crop has to stay honest.
    const svg = el().querySelector('svg') as SVGSVGElement;
    const box = svg.viewBox.baseVal;

    const bounds = Array.from(svg.querySelectorAll('path')).map((path) =>
      (path as SVGGraphicsElement).getBBox(),
    );
    expect(bounds.length).toBe(7);

    for (const b of bounds) {
      expect(b.x).toBeGreaterThanOrEqual(box.x);
      expect(b.y).toBeGreaterThanOrEqual(box.y);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
      expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  it('tones the logotype for the ground it is standing on', () => {
    expect(groups()[1].getAttribute('class')).toContain('text-ink');

    setTone('chrome');

    expect(groups()[1].getAttribute('class')).toContain('text-chrome-fg');
    expect(groups()[1].getAttribute('class')).not.toContain('text-ink');
  });

  it('never tones the emblem — the brand colour does not follow the host', () => {
    // The tone exists because the two frames have opposite grounds. The ACCENT does
    // not: it is brand red on both, and reads --admin-accent so §16's pending
    // brand-red review stays a one-line change in styles.css.
    expect(groups()[0].getAttribute('class')).toContain('text-admin-accent');

    setTone('chrome');

    expect(groups()[0].getAttribute('class')).toContain('text-admin-accent');
  });
});
