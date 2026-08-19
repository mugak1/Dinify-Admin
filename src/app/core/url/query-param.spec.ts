import { Component, inject } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { booleanParam, enumParam, stringParam, urlState } from './query-param';

const STATUSES = ['onboarding', 'live', 'suspended', 'offboarded'] as const;

@Component({ selector: 'app-probe', template: '' })
class ProbeComponent {
  readonly router = inject(Router);
  private readonly url = urlState();

  readonly status = this.url.param('status', enumParam(STATUSES));
  readonly attention = this.url.param('attention', booleanParam());
  readonly search = this.url.param('q', stringParam());
}

/**
 * FILTERS LIVE IN THE URL, NOT IN COMPONENT STATE (spec §9.2).
 *
 * The directory itself is step 1, but the mechanism it depends on is proven here —
 * without it the needs-attention links from Home cannot exist at all.
 */
describe('urlState', () => {
  let harness: RouterTestingHarness;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: 'restaurants', component: ProbeComponent }])],
    });
    harness = await RouterTestingHarness.create();
  });

  it('reads both filters out of the entry URL', async () => {
    const probe = await harness.navigateByUrl(
      '/restaurants?status=onboarding&attention=true',
      ProbeComponent,
    );

    expect(probe.status.value()).toBe('onboarding');
    expect(probe.attention.value()).toBeTrue();
  });

  it('round-trips: writing both filters produces exactly that URL', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants', ProbeComponent);

    probe.status.set('onboarding');
    probe.attention.set(true);
    tick();

    // The address in the spec, character for character.
    expect(probe.router.url).toBe('/restaurants?status=onboarding&attention=true');
  }));

  it('batches simultaneous writes into ONE navigation, losing neither', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants', ProbeComponent);

    // Two synchronous navigations would race and the loser's parameter would vanish —
    // which is exactly what a "clear all filters" button does.
    probe.status.set('live');
    probe.attention.set(true);
    probe.search.set('kampala');
    tick();

    expect(probe.router.url).toContain('status=live');
    expect(probe.router.url).toContain('attention=true');
    expect(probe.router.url).toContain('q=kampala');
  }));

  it('merges rather than replacing, so one filter cannot drop another', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants?attention=true', ProbeComponent);

    probe.status.set('suspended');
    tick();

    expect(probe.router.url).toContain('attention=true');
    expect(probe.router.url).toContain('status=suspended');
  }));

  it('omits a parameter that is at its default, keeping ordinary URLs short', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants?status=live&attention=true', ProbeComponent);

    probe.attention.set(false);
    tick();

    expect(probe.router.url).toBe('/restaurants?status=live');

    probe.status.set(null);
    tick();

    expect(probe.router.url).toBe('/restaurants');
  }));

  it('survives a hand-edited URL rather than throwing', async () => {
    const probe = await harness.navigateByUrl(
      '/restaurants?status=not-a-state&attention=yes',
      ProbeComponent,
    );

    // A filter is not a security boundary and must never break a page.
    expect(probe.status.value()).toBeNull();
    expect(probe.attention.value()).toBeFalse();
  });

  it('follows the URL when the browser navigates, not only when the component writes', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants?status=live', ProbeComponent);
    expect(probe.status.value()).toBe('live');

    // Stands in for Back/Forward or a pasted link.
    await probe.router.navigateByUrl('/restaurants?status=suspended');
    tick();

    expect(probe.status.value()).toBe('suspended');
  }));

  it('replaces rather than pushes, so filtering does not bury the previous page', fakeAsync(async () => {
    const probe = await harness.navigateByUrl('/restaurants', ProbeComponent);
    const before = history.length;

    probe.status.set('live');
    tick();
    probe.status.set('suspended');
    tick();
    probe.status.set('offboarded');
    tick();

    // Back should leave the screen, not undo three keystrokes.
    expect(history.length).toBe(before);
  }));
});
