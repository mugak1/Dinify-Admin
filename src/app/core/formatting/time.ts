/**
 * Time formatting. `15:42 EAT · 19 Aug 2026` — always East Africa Time, always
 * labelled (spec §16).
 *
 * WHY THE LABEL IS NOT OPTIONAL. Administration may happen from another timezone —
 * the operator on a laptop in London reading when a restaurant was suspended in
 * Kampala. "Yesterday at 23:50" is ambiguous to the point of being wrong, and a
 * lifecycle decision made against the wrong day is not a cosmetic error. Every
 * timestamp in this application therefore names its zone.
 *
 * Africa/Kampala is UTC+3 with no daylight saving, so `Intl` needs no special
 * handling — but the zone is still passed explicitly rather than relying on that,
 * because a hardcoded offset would be a fact about today rather than a rule.
 */

export const EAT_TIME_ZONE = 'Africa/Kampala';

/**
 * `Intl` renders this zone as `GMT+3`; the operator's vocabulary is `EAT`, so the
 * label is applied by hand. `en-GB` gives 24-hour time and `19 Aug 2026` ordering.
 */
const EAT_LABEL = 'EAT';

const TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: EAT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: EAT_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Rendered when a timestamp is missing or unparseable. */
export const NO_TIME = '—';

/** `15:42 EAT · 19 Aug 2026` */
export function formatEat(iso: string | null | undefined): string {
  const date = parse(iso);
  if (!date) return NO_TIME;
  return `${TIME.format(date)} ${EAT_LABEL} · ${DATE.format(date)}`;
}

/** `19 Aug 2026` — for a column where the time of day is noise. */
export function formatEatDate(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? DATE.format(date) : NO_TIME;
}

/** `15:42 EAT` — for a column already grouped by day. */
export function formatEatTime(iso: string | null | undefined): string {
  const date = parse(iso);
  return date ? `${TIME.format(date)} ${EAT_LABEL}` : NO_TIME;
}

/**
 * `4 minutes ago` — relative to the SERVER's clock, never the browser's.
 *
 * `nowMs` comes from `SessionStore.serverNowMs()`, which is anchored on the
 * `server_time` the server last stated and advanced with a monotonic clock. Passing
 * `Date.now()` here would silently reintroduce the skew this whole arrangement
 * exists to avoid, so the anchor is a REQUIRED argument rather than a default: a
 * caller that has no server anchor must show an absolute time instead of guessing.
 *
 * Returns null when no relative form is meaningful, so the caller can fall back.
 */
export function formatRelativeToServer(
  iso: string | null | undefined,
  nowMs: number | null,
): string | null {
  const date = parse(iso);
  if (!date || nowMs === null) return null;

  const deltaSeconds = Math.round((date.getTime() - nowMs) / 1000);
  const magnitude = Math.abs(deltaSeconds);

  if (magnitude < 45) return 'just now';

  const relative = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  for (const [unit, seconds] of UNITS) {
    if (magnitude >= seconds) {
      return relative.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return relative.format(deltaSeconds, 'second');
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/**
 * `Date.parse` on an ISO string carrying an offset yields an absolute instant and
 * does NOT consult the local clock, so parsing a server timestamp is safe even on a
 * machine whose clock is wrong.
 */
function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}
