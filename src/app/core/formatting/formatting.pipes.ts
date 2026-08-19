import { Pipe, PipeTransform } from '@angular/core';

import { formatAmount, formatUGX } from './currency';
import { formatEat, formatEatDate, formatEatTime, formatRelativeToServer } from './time';

/**
 * Template wrappers over the pure formatters.
 *
 * The functions are the implementation and the pipes are sugar — nothing downstream
 * should reimplement either, which is the whole point of shipping them at step 0.
 * All are pure: they depend only on their arguments, so a relative time that must
 * tick is given the clock as an ARGUMENT (`SessionStore.serverNowMs()`, itself a
 * signal) rather than reaching for one internally. That keeps them cheap and keeps
 * the server anchor visible at every call site.
 */

/** `UGX 150,000` */
@Pipe({ name: 'ugx' })
export class UgxPipe implements PipeTransform {
  transform(value: string | number | null | undefined): string {
    return formatUGX(value);
  }
}

/** `150,000` — for a column whose header already says UGX. */
@Pipe({ name: 'amount' })
export class AmountPipe implements PipeTransform {
  transform(value: string | number | null | undefined): string {
    return formatAmount(value);
  }
}

/** `15:42 EAT · 19 Aug 2026`, or a narrower form. */
@Pipe({ name: 'eat' })
export class EatPipe implements PipeTransform {
  transform(value: string | null | undefined, form: 'full' | 'date' | 'time' = 'full'): string {
    if (form === 'date') return formatEatDate(value);
    if (form === 'time') return formatEatTime(value);
    return formatEat(value);
  }
}

/**
 * `4 minutes ago`, anchored on the server's clock.
 *
 * `nowMs` is required. Pass `session.serverNowMs()` — a signal read in the template,
 * which is also what makes this pure pipe re-evaluate as time passes. With no anchor
 * it falls back to the absolute EAT form rather than inventing one from `Date.now()`.
 */
@Pipe({ name: 'eatRelative' })
export class EatRelativePipe implements PipeTransform {
  transform(value: string | null | undefined, nowMs: number | null): string {
    return formatRelativeToServer(value, nowMs) ?? formatEat(value);
  }
}
