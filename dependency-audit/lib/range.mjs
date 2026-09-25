/**
 * The subset of semver range syntax this directory needs, in two places:
 *
 *   - npm ADVISORY ranges (`>=4.0.0 <4.3.2`, `<=3.4.0`, hyphen ranges, `||`), so an
 *     advisory is attributed only to the installed nodes whose version it names;
 *   - package `engines.node` ranges (`^22.20 || ^24.12 || >=25`), because npm skips an
 *     OPTIONAL package whose engines this Node does not satisfy, and the inventory has to
 *     explain every locked-but-absent package rather than guess.
 *
 * It answers null for anything it cannot parse. Callers treat null in the direction that
 * REPORTS MORE: an unparseable advisory range is attributed to every node npm listed, and
 * an unparseable engines range explains nothing (so the absence stays a problem).
 *
 * Prereleases are included, because npm evaluates BOTH with `includePrerelease`
 * (@npmcli/metavuln-calculator's advisory test and npm-install-checks' engines test).
 * Under that option node-semver floors every lower bound it DERIVES from a partial
 * version at the lowest prerelease — `>=1.0`, `^1.2`, `~1`, `1.x` and `>1.2` start at
 * `…-0`, so `1.0.0-beta.1` is inside `>=1.0` — and floors the start of a hyphen range
 * even when it is a full version. A lower bound STATED as a full version keeps exactly
 * what it says (`>=1.0.0` still excludes `1.0.0-beta.1`). Missing a floor is not
 * harmless: an advisory is attributed to the nodes its range matches, so a prerelease
 * node wrongly read as outside the range drops out of the findings whenever another
 * node does match — and a runtime path can vanish behind a tooling one.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const m = VERSION.exec(String(text).trim());
  if (!m) return null;
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]); const nb = /^\d+$/.test(b[i]);
    if (na && nb) { const d = Number(a[i]) - Number(b[i]); if (d) return Math.sign(d); continue; }
    if (na) return -1;
    if (nb) return 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function compare(a, b) {
  for (let i = 0; i < 3; i += 1) if (a.main[i] !== b.main[i]) return a.main[i] < b.main[i] ? -1 : 1;
  return comparePre(a.pre, b.pre);
}

const v = (major, minor, patch, pre = []) => ({ main: [major, minor, patch], pre });
const LOWEST = ['0']; // `-0`: the smallest prerelease, so `<2.0.0-0` excludes every 2.x.

/** A possibly-partial version: how many numeric parts were given, and the rest. */
function parsePartial(text) {
  const m = PARTIAL.exec(text);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]];
  const given = [];
  let wild = false;
  for (const p of parts) {
    if (p === undefined) break;
    if (/^[xX*]$/.test(p)) { wild = true; continue; }
    if (wild) return null; // `1.x.2`: node-semver refuses a number after a wildcard
    given.push(Number(p));
  }
  const pre = m[4] ? m[4].split('.') : [];
  if (pre.length && given.length < 3) return null; // `>=1.2-beta` is not a range either
  return { given, pre };
}

/** One comparator token → a list of [op, version] bounds, or null. */
function desugar(token) {
  const m = /^(\^|~|<=|>=|<|>|=)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = parsePartial(m[2]);
  if (!p) return null;
  const [a, b, c] = p.given;
  const n = p.given.length;
  const full = n === 3 ? v(a, b, c, p.pre) : null;
  // The lower bound a partial version implies, floored at the lowest prerelease (see the
  // header): `1` and `1.2` start at 1.0.0-0 and 1.2.0-0, never at 1.0.0 and 1.2.0.
  const floor = full ?? v(a, b ?? 0, 0, LOWEST);
  switch (op) {
    case '^': {
      if (n === 0) return [];
      let hi;
      if (a > 0 || n === 1) hi = v(a + 1, 0, 0, LOWEST);
      else if ((b ?? 0) > 0 || n === 2) hi = v(0, (b ?? 0) + 1, 0, LOWEST);
      else hi = v(0, 0, (c ?? 0) + 1, LOWEST);
      return [['>=', floor], ['<', hi]];
    }
    case '~': {
      if (n === 0) return [];
      const hi = n === 1 ? v(a + 1, 0, 0, LOWEST) : v(a, b + 1, 0, LOWEST);
      return [['>=', floor], ['<', hi]];
    }
    case '>=': return n === 0 ? [] : [['>=', floor]];
    case '<': return n === 0 ? [['<', v(0, 0, 0, LOWEST)]] : [['<', full ?? v(a, b ?? 0, c ?? 0, LOWEST)]];
    case '>': {
      if (n === 0) return [['<', v(0, 0, 0, LOWEST)]];
      if (full) return [['>', full]];
      return [['>=', n === 1 ? v(a + 1, 0, 0, LOWEST) : v(a, b + 1, 0, LOWEST)]];
    }
    case '<=': {
      if (n === 0) return [];
      if (full) return [['<=', full]];
      return [['<', n === 1 ? v(a + 1, 0, 0, LOWEST) : v(a, b + 1, 0, LOWEST)]];
    }
    default: { // '' or '='
      if (n === 0) return [];
      if (full) return [['=', full]];
      return [['>=', floor], ['<', n === 1 ? v(a + 1, 0, 0, LOWEST) : v(a, b + 1, 0, LOWEST)]];
    }
  }
}

function parseSet(text) {
  const t = text.trim();
  if (t === '' || t === '*') return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(t);
  if (hyphen) {
    const lo = desugar(`>=${hyphen[1]}`); const hi = desugar(`<=${hyphen[2]}`);
    if (!lo || !hi) return null;
    // node-semver floors a hyphen range's start even when it is a full version:
    // `1.2.3 - 2` admits 1.2.3-beta. A start that states its own prerelease keeps it.
    const start = lo.map(([op, bound]) => [op, bound.pre.length ? bound : { ...bound, pre: LOWEST }]);
    return [...start, ...hi];
  }
  const out = [];
  for (const token of t.replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1').split(/\s+/)) {
    const bounds = desugar(token);
    if (bounds === null) return null;
    out.push(...bounds);
  }
  return out;
}

/** true / false, or null when the version or range is outside the supported subset. */
export function satisfies(version, range) {
  const ver = parseVersion(version);
  if (!ver || typeof range !== 'string') return null;
  const sets = range.split('||').map(parseSet);
  if (sets.some((s) => s === null)) return null;
  return sets.some((set) => set.every(([op, bound]) => {
    const c = compare(ver, bound);
    switch (op) {
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      default: return c === 0;
    }
  }));
}
