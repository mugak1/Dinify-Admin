import { DestroyRef, inject, Signal, signal } from '@angular/core';
import { ActivatedRoute, Params, Router } from '@angular/router';

/**
 * FILTERS LIVE IN THE URL, NOT IN COMPONENT STATE (spec §9.2).
 *
 * `/restaurants?status=onboarding&attention=true` has to be a real address: browser
 * Back must work, refresh must preserve what was on screen, and a needs-attention
 * item on Home has to be able to LINK to a filtered directory. None of that is
 * possible if the filter lives in a component field, which is exactly why this helper
 * exists at step 0 — step 1 inherits it rather than reinventing it, and inheriting it
 * is what makes the Home links work at all.
 *
 * ── DESIGN NOTES ──────────────────────────────────────────────────────────────────
 *
 * WRITES USE `replaceUrl: true`. Typing into a filter must not bury the previous page
 * under twenty history entries; Back should leave the screen, not undo a keystroke.
 *
 * WRITES USE `queryParamsHandling: 'merge'`. Each parameter owns only itself, so
 * setting `status` cannot silently drop `attention`.
 *
 * WRITES ARE BATCHED to one navigation per microtask. Two synchronous `navigate()`
 * calls race, and the loser's parameter is lost — an easy bug to introduce and a
 * miserable one to find, because it only shows up when two filters change together
 * (which is precisely what a "clear all filters" button does).
 *
 * A PARAMETER AT ITS DEFAULT IS OMITTED, not written as `?attention=false`. Ordinary
 * URLs stay short and shareable, and there is exactly one URL for a given view.
 */

/** Parse and serialise one query parameter. `null` from `serialize` omits it. */
export interface QueryParamCodec<T> {
  parse(raw: string | null): T;
  serialize(value: T): string | null;
}

/** One URL-backed value: read the signal, call `set` to publish. */
export interface UrlParam<T> {
  /** The current value, kept in sync with the URL in both directions. */
  readonly value: Signal<T>;
  /** Publish a new value to the URL. Merged, replaced, and batched. */
  set(value: T): void;
}

export interface UrlState {
  param<T>(name: string, codec: QueryParamCodec<T>): UrlParam<T>;
}

/**
 * Create a URL-backed parameter group.
 *
 * MUST be called from an injection context that belongs to the ROUTED COMPONENT — a
 * field initialiser or a constructor — because it resolves `ActivatedRoute` and
 * navigates relative to it. Called from a root service it would navigate relative to
 * the root route and throw the current path away.
 */
export function urlState(): UrlState {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const destroyRef = inject(DestroyRef);

  let pending: Params = {};
  let scheduled = false;

  const flush = (): void => {
    const queryParams = pending;
    pending = {};
    scheduled = false;
    void router.navigate([], {
      relativeTo: route,
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  };

  const publish = (name: string, raw: string | null): void => {
    // `null` removes the parameter under `merge`, which is how a default is omitted.
    pending[name] = raw;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  return {
    param<T>(name: string, codec: QueryParamCodec<T>): UrlParam<T> {
      const state = signal<T>(codec.parse(route.snapshot.queryParamMap.get(name)));

      // The URL is the source of truth, so Back/Forward and a pasted link all flow
      // back into the signal through here rather than through any component code.
      const subscription = route.queryParamMap.subscribe((map) => {
        const next = codec.parse(map.get(name));
        if (!Object.is(next, state())) state.set(next);
      });
      destroyRef.onDestroy(() => subscription.unsubscribe());

      return {
        value: state.asReadonly(),
        set(next: T): void {
          if (Object.is(next, state())) return;
          state.set(next);
          publish(name, codec.serialize(next));
        },
      };
    },
  };
}

/** A free-text parameter. Absent and empty both read as the default. */
export function stringParam(defaultValue: string | null = null): QueryParamCodec<string | null> {
  return {
    parse: (raw) => (raw === null || raw === '' ? defaultValue : raw),
    serialize: (value) => (value === defaultValue || value === null || value === '' ? null : value),
  };
}

/**
 * A flag. Present-and-`true` is on; ANYTHING else is off.
 *
 * Fail-soft on purpose: `?attention=yes` from a hand-edited URL reads as off rather
 * than throwing. A filter is not a security boundary and must never break a page.
 */
export function booleanParam(defaultValue = false): QueryParamCodec<boolean> {
  return {
    parse: (raw) => (raw === null ? defaultValue : raw === 'true'),
    serialize: (value) => (value === defaultValue ? null : String(value)),
  };
}

/** A closed set. An unrecognised value falls back to the default and is dropped. */
export function enumParam<T extends string>(
  allowed: readonly T[],
  defaultValue: T | null = null,
): QueryParamCodec<T | null> {
  return {
    parse: (raw) => (raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : defaultValue),
    serialize: (value) => (value === null || value === defaultValue ? null : value),
  };
}
