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
 * ══ WRITING A COMMERCIAL MOMENT (Step 3E.3) ══════════════════════════════════════
 *
 * Everything above READS a server instant and renders it in EAT. This writes the
 * other way: the operator types a wall time they mean in EAT, and the wire needs the
 * instant it denotes.
 *
 * ── WHY `new Date(value).toISOString()` IS THE WRONG ANSWER ───────────────────────
 *
 * An `<input type="datetime-local">` yields a bare wall time — `2026-08-25T15:00` —
 * with no zone at all. Passing that to `new Date()` interprets it in the BROWSER'S
 * timezone. An operator administering from London would then silently send 15:00 BST,
 * which is 17:00 EAT: a different instant, on a field that decides which terms were in
 * force. Nothing on screen would show the substitution happening.
 *
 * The backend refuses a naive timestamp outright for the same reason, so the failure
 * mode is not a 400 — it is a well-formed request carrying the wrong moment.
 *
 * ── THE OFFSET IS DERIVED FROM THE ZONE, NOT HARDCODED ───────────────────────────
 *
 * Africa/Kampala is UTC+3 with no daylight saving, so `+03:00` is correct today — and
 * writing it as a literal would be a fact about today rather than a rule, which is the
 * same reasoning that makes the formatters above name the zone explicitly. The offset
 * is measured from `Intl` at the instant in question, by formatting a candidate into
 * the zone and diffing. A second pass settles the case of a wall time that lands near
 * a transition, which this zone does not have and a future zone change might.
 */

/** `2026-08-25T15:00` (or with seconds) — what a `datetime-local` input produces. */
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A wall time the operator means in EAT -> an ISO-8601 instant carrying the explicit
 * offset, e.g. `2026-08-25T15:00:00+03:00`.
 *
 * Returns null for anything that is not a complete wall time, so a caller renders a
 * field error rather than sending a guess. THE BROWSER'S OWN TIMEZONE IS NEVER READ.
 */
export function eatWallTimeToIso(wall: string | null | undefined): string | null {
  const match = WALL_TIME.exec((wall ?? '').trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const seconds = second ?? '00';

  // The same wall clock read as if it were UTC. Only a starting point: it is offset by
  // exactly the amount being measured, which is why the measurement is repeated below.
  const asUtc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(seconds),
  );

  // Two passes. The first offset is measured at the wrong instant (out by the offset
  // itself); applying it lands on the right one, and re-measuring there is what makes
  // a wall time sitting near a transition resolve correctly.
  const firstPass = zoneOffsetMinutes(asUtc);
  const offsetMinutes = zoneOffsetMinutes(asUtc - firstPass * 60_000);

  return `${year}-${month}-${day}T${hour}:${minute}:${seconds}${formatOffset(offsetMinutes)}`;
}

/**
 * How far ahead of UTC `EAT_TIME_ZONE` is at `instant`, in minutes.
 *
 * Measured rather than assumed: the instant is formatted INTO the zone and the result
 * read back as if it were UTC, so the difference is the offset. Works on every engine
 * without depending on `timeZoneName: 'longOffset'`.
 */
function zoneOffsetMinutes(instant: number): number {
  const parts = OFFSET_PROBE.formatToParts(new Date(instant));
  const read = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    read('year'), read('month') - 1, read('day'),
    read('hour'), read('minute'), read('second'),
  );
  return Math.round((asIfUtc - instant) / 60_000);
}

const OFFSET_PROBE = new Intl.DateTimeFormat('en-US', {
  timeZone: EAT_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `180` -> `+03:00`. */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const total = Math.abs(minutes);
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const rest = String(total % 60).padStart(2, '0');
  return `${sign}${hours}:${rest}`;
}

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
