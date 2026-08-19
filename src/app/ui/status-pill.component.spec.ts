import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { StatusPillComponent, StatusPillVariant } from './status-pill.component';

@Component({
  selector: 'app-pill-host',
  imports: [StatusPillComponent],
  template: `
    @for (variant of variants; track variant) {
      <app-status-pill [variant]="variant" />
    }
  `,
})
class PillHostComponent {
  readonly variants: StatusPillVariant[] = [
    'onboarding',
    'live',
    'suspended',
    'offboarded',
    'neutral',
    'test',
  ];
}

describe('StatusPillComponent', () => {
  let fixture: ComponentFixture<PillHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PillHostComponent] }).compileComponents();
    fixture = TestBed.createComponent(PillHostComponent);
    fixture.detectChanges();
  });

  function pills(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('app-status-pill span'));
  }

  it('covers the four lifecycle states plus TEST and neutral', () => {
    expect(pills().map((el) => el.textContent?.trim())).toEqual([
      'Onboarding',
      'Live',
      'Suspended',
      'Offboarded',
      'Unknown',
      'Test',
    ]);
  });

  /**
   * Spec §16: badges are STATUS, never a control. A badge that is sometimes clickable
   * teaches the operator to click badges that are not.
   */
  it('is NEVER interactive', () => {
    for (const pill of pills()) {
      expect(pill.tagName).toBe('SPAN');
      expect(pill.hasAttribute('tabindex')).withContext('tabindex').toBeFalse();
      expect(pill.hasAttribute('role')).withContext('role').toBeFalse();
      expect(pill.getAttribute('class') ?? '')
        .withContext('no hover or pointer affordance')
        .not.toMatch(/hover:|cursor-pointer|focus:/);
    }
  });

  /**
   * §16 requires test restaurants to be UNMISTAKABLE. Hue alone is not enough — an
   * operator scanning a directory reads shape before colour. TEST is the only pill
   * with a SOLID fill, so it differs in form from every lifecycle state.
   */
  it('gives TEST a solid fill that no lifecycle state uses', () => {
    const classes = pills().map((el) => el.getAttribute('class') ?? '');
    const test = classes[5];
    const lifecycle = classes.slice(0, 4);

    expect(test).toContain('bg-state-test');
    expect(test).not.toContain('-soft');
    for (const entry of lifecycle) {
      expect(entry).toContain('-soft');
      expect(entry).not.toContain('bg-state-test');
    }
  });

  it('lets a caller override the label without changing the colour', () => {
    const solo = TestBed.createComponent(StatusPillComponent);
    solo.componentRef.setInput('variant', 'live');
    solo.componentRef.setInput('label', 'Trading');
    solo.detectChanges();

    const span: HTMLElement = solo.nativeElement.querySelector('span');
    expect(span.textContent?.trim()).toBe('Trading');
    expect(span.getAttribute('class')).toContain('state-live');
  });
});
