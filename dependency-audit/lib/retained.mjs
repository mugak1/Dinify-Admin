/**
 * THE RETAINED-CANDIDATE PATH — a fresh advisory query over the dependency graph a
 * certified candidate was BUILT FROM, long after the build machine is gone (D08 B2.2).
 *
 * `audit()` scans a checkout: it walks the node_modules `npm ci` just installed and
 * refuses anything else. A promotion has no such checkout. It holds a candidate, and
 * beside it the evidence certification retained: the exact package.json and lockfile,
 * and the snapshot certification took of the tree those two produced. This module is the
 * EXPLICIT path for that situation, kept apart from `audit()`/`reevaluate()` so neither of
 * their checkout bindings is relaxed to make it fit.
 *
 * WHAT IS OBSERVED AND WHAT IS NOT, stated because the difference is the whole point:
 *   - The advisory answer is a NEW query, made now, by the pinned scanner, over the
 *     retained lock graph. `npm audit` reads the LOCKFILE graph (Arborist's
 *     `loadVirtual`), so a directory holding only the two retained files is asked
 *     exactly the question certification asked — it is a scan-only replay, not a
 *     reinstall, and no package code, lifecycle script or build of the candidate runs.
 *   - WHAT WAS INSTALLED is not re-observed. It cannot be: those bytes are gone. It is
 *     the CERTIFICATION-TIME observation (installed paths and versions, and why each
 *     locked-but-absent optional package was absent), read from the retained snapshot
 *     and checked here to be exactly the retained lock graph. No node_modules is forged
 *     and nothing calls one "observed".
 *   - A digest of an installed tree is a digest of package PATHS AND VERSIONS, as npm
 *     wrote them. It is not a hash of every executable byte, and nothing here says it is.
 *
 * `collect()` is the per-graph scan used for all three graphs a promotion assesses
 * (retained application, installed scanner, installed publisher toolchain). It records
 * each scanner run's own start and finish from the injected clock, so no timestamp is
 * reused for several lifecycle facts.
 *
 * The scanner runner and the clock are parameters so the regression matrix can drive
 * every failure deterministically. There is no flag, variable or policy field that
 * substitutes another scanner, registry or threshold.
 */

import {
  closeSync, constants as FS, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { defaultScope, inventory, readReport, scannerArgs, scannerEnvironment, sha256 } from './npm.mjs';

export const RETAINED_OBSERVATION = 'certification-snapshot';
export const INSTALLED_OBSERVATION = 'installed-now';
const ABSENCE_REASONS = new Set(['platform', 'engines', 'optional-subtree']);
const FLAGS = ['dev', 'optional', 'devOptional', 'peer', 'inBundle', 'link'];

const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameSpecs = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The lock graph of RETAINED manifest + lockfile bytes, reconciled against the retained
 * certification snapshot rather than against a node_modules that no longer exists.
 *
 * Returns the same {packages, problems, digests, counts} shape `inventory()` does, so the
 * report reader is unchanged, plus `observation` naming where "installed" came from. Any
 * problem makes it unusable as evidence.
 *
 * @param {object} input
 * @param {string} input.graph           graph label; the snapshot's paths carry it as a prefix
 * @param {Buffer} input.manifestBytes   the retained package.json, exactly
 * @param {Buffer} input.lockBytes       the retained package-lock.json, exactly
 * @param {object} input.snapshot        the retained certification snapshot document
 */
export function retainedInventory({ graph, manifestBytes, lockBytes, snapshot }) {
  const problems = [];
  const empty = (code, detail) => ({ packages: [], problems: [{ code, detail: `${graph}: ${detail}` }], digests: {}, counts: {}, observation: RETAINED_OBSERVATION });
  let lock;
  let manifest;
  try { lock = JSON.parse(lockBytes); manifest = JSON.parse(manifestBytes); } catch (error) {
    return empty('unreadable_manifest', `the retained manifest or lockfile is not JSON (${error.message})`);
  }
  if (!isMapping(lock) || !isMapping(manifest)) return empty('unreadable_manifest', 'the retained manifest or lockfile is not a JSON object');
  if (![2, 3].includes(lock.lockfileVersion) || !isMapping(lock.packages) || !isMapping(lock.packages[''])) {
    return empty('lockfile_version', `lockfileVersion ${lock.lockfileVersion} has no packages map`);
  }
  if (!isMapping(snapshot) || !isMapping(snapshot.binding) || !isMapping(snapshot.binding.application) || !Array.isArray(snapshot.packages)) {
    return empty('snapshot_unreadable', 'the retained snapshot carries no binding or package list');
  }
  if (!Array.isArray(snapshot.problems) || snapshot.problems.length > 0) {
    return empty('snapshot_problems', 'the retained snapshot recorded problems of its own — it was never usable evidence');
  }
  const bound = snapshot.binding.application;
  const lockfileSha256 = sha256(lockBytes);
  const manifestSha256 = sha256(manifestBytes);
  if (bound.lockfileSha256 !== lockfileSha256) problems.push({ code: 'retained_mismatch', detail: `${graph}: the retained lockfile is not the one the snapshot was taken over` });
  if (bound.manifestSha256 !== manifestSha256) problems.push({ code: 'retained_mismatch', detail: `${graph}: the retained package.json is not the one the snapshot was taken over` });

  const rootEntry = lock.packages[''];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!sameSpecs(rootEntry[field], manifest[field])) problems.push({ code: 'lock_manifest_mismatch', detail: `${graph}: package-lock.json ${field} does not match package.json` });
  }

  // THE SAME RECORD SHAPE `inventory()` BUILDS, from the lock alone. The snapshot must
  // agree with it field for field: the snapshot is the observation of THIS graph, not a
  // list that happens to share some names with it.
  const observed = new Map();
  for (const record of snapshot.packages) {
    if (!isMapping(record) || typeof record.path !== 'string' || !record.path.startsWith(`${graph}:`)) {
      problems.push({ code: 'snapshot_foreign', detail: `${graph}: the snapshot lists ${JSON.stringify(record?.path)}, which is not a ${graph} path` });
      continue;
    }
    if (observed.has(record.path)) problems.push({ code: 'snapshot_duplicate', detail: `${graph}: the snapshot lists ${record.path} twice` });
    observed.set(record.path, record);
  }
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    if (!isMapping(entry)) { problems.push({ code: 'unexpected_lock_entry', detail: `${graph}: ${path} is not an entry` }); continue; }
    if (!path.startsWith('node_modules/') && !entry.link) {
      problems.push({ code: 'unexpected_lock_entry', detail: `${graph}: ${path} is not under node_modules` });
      continue;
    }
    if (!entry.version && !entry.link) problems.push({ code: 'unversioned_lock_entry', detail: `${graph}: ${path} has no version` });
    const expected = {
      path: `${graph}:${path}`,
      name: entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version ?? null,
      integrity: entry.integrity ?? null,
      scope: defaultScope(entry),
      flags: FLAGS.filter((f) => entry[f]),
    };
    const seen = observed.get(expected.path);
    observed.delete(expected.path);
    if (!seen) {
      problems.push({ code: 'snapshot_incomplete', detail: `${graph}: ${path} is locked but the snapshot does not account for it` });
      continue;
    }
    for (const key of ['name', 'version', 'integrity', 'scope']) {
      if (seen[key] !== expected[key]) problems.push({ code: 'snapshot_disagrees', detail: `${graph}: ${path} ${key} is ${JSON.stringify(seen[key])} in the snapshot and ${JSON.stringify(expected[key])} in the lock` });
    }
    if (!sameList(seen.flags, expected.flags)) problems.push({ code: 'snapshot_disagrees', detail: `${graph}: ${path} flags differ between the snapshot and the lock` });
    // Installed, or absent for a reason npm itself would have: nothing else.
    if (seen.installed === true) {
      if (seen.absence !== null) problems.push({ code: 'snapshot_disagrees', detail: `${graph}: ${path} is recorded both installed and absent` });
    } else if (seen.installed === false) {
      if (!(ABSENCE_REASONS.has(seen.absence) || (entry.link && seen.absence === null))) {
        problems.push({ code: 'snapshot_unexplained_absence', detail: `${graph}: ${path} was not installed and the snapshot gives no reason npm would accept` });
      }
    } else {
      problems.push({ code: 'snapshot_disagrees', detail: `${graph}: ${path} has no installed observation` });
    }
    packages.push({ ...expected, installed: seen.installed === true, absence: seen.installed === true ? null : seen.absence ?? null });
  }
  for (const path of observed.keys()) problems.push({ code: 'snapshot_extraneous', detail: `${graph}: the snapshot lists ${path}, which the lock does not` });
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!lock.packages[`node_modules/${name}`]) problems.push({ code: 'missing_declared', detail: `${graph}: ${name} is declared but not in the lock graph` });
    }
  }
  if (packages.length === 0) problems.push({ code: 'empty_inventory', detail: `${graph}: the lock graph has no packages` });

  const installed = packages.filter((p) => p.installed).length;
  if (bound.locked !== packages.length || bound.installed !== installed) {
    problems.push({ code: 'snapshot_disagrees', detail: `${graph}: the snapshot binding counts ${bound.locked}/${bound.installed}, its package list ${packages.length}/${installed}` });
  }
  return {
    packages,
    problems,
    observation: RETAINED_OBSERVATION,
    digests: { lockfileSha256, manifestSha256, installedTreeSha256: bound.installedTreeSha256 ?? null },
    counts: {
      locked: packages.length,
      installed,
      absentOptional: packages.filter((p) => p.absence !== null).length,
      runtime: packages.filter((p) => p.scope === 'runtime').length,
      tooling: packages.filter((p) => p.scope === 'tooling').length,
    },
  };
}

/**
 * The replay directory for a retained graph: EXACTLY the two retained files and nothing
 * else — no node_modules, no .npmrc, no scripts. A directory that already holds anything
 * is refused rather than cleaned, because a leftover file would change what is asked.
 */
export function writeReplay(dir, { manifestBytes, lockBytes }) {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    return [{ code: 'replay_not_empty', detail: `the replay directory ${dir} is not empty` }];
  }
  writeFileSync(join(dir, 'package.json'), manifestBytes);
  writeFileSync(join(dir, 'package-lock.json'), lockBytes);
  return [];
}

/** What a replay directory holds, as data: its entry names and the two files' digests. */
function replayState(dir) {
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  const digest = (name) => (names.includes(name) ? sha256(readFileSync(join(dir, name))) : null);
  return { names, manifest: digest('package.json'), lock: digest('package-lock.json') };
}

// ── the scanner's own record of what it was doing (D08 lane A) ─────────────────────
//
// WHY. Readiness run 36283185235 went red because the application scan reached the policy
// timeout, and all it left was an empty stdout, an empty stderr and a SIGTERM. npm writes
// what it was doing to a DEBUG LOG, and that log went to the runner's home directory and
// was gone with the runner. Its cause stays UNKNOWN; nothing here recovers it.
//
// WHAT THIS KEEPS, AND WHAT IT CANNOT SAY. Each scan is given its own fresh, absolute log
// directory (`--logs-dir`, one npm config key: the scanner, its version, registry, audit
// flags, timeout, retries and cache are untouched), outside everything scanned or
// uploaded. After the scan — whatever its outcome — at most ONE regular log file from
// that directory is read, from its END, within a fixed window, and re-rendered as a small
// allowlisted projection of npm's own events (requests started, responses completed,
// retries, audit errors, exit code). Every retained field is re-validated and re-written,
// never copied: URLs lose credentials and queries, anything not on the allowlist —
// configuration, argv, paths, environment, stack traces — is counted and dropped. It is a
// SANITIZED PROJECTION, not a complete raw log, and the file says so in its first line.
//
// These are the LAST OBSERVED npm EVENTS, nothing more. npm writes a request's line when
// its response body ENDS (npm-registry-fetch's check-response.js; for an error status, when
// the status arrives), several requests can be outstanding at once, and a process can
// be waiting on something no line mentions — so the last line is never evidence of which
// request stalled, and no reader here names one.
//
// A diagnostic is DIAGNOSTIC ONLY: whether it could be kept never changes a scan's
// classification, and a failure to keep it never replaces the scan's own result.
//
// This section is shared: Dinify-Frontend and Dinify-Admin carry the same file, and each
// repository's release/README.md ("Scanner diagnostics") says how its own gate uses it.

export const DIAGNOSTIC_FORMAT = 'dinify.npm-diagnostic-events/1';
export const DIAGNOSTIC_HEADER = `# ${DIAGNOSTIC_FORMAT}: SANITIZED npm events, NOT a complete raw log`;
const DIAGNOSTIC_READING = '# reading: these are the LAST OBSERVED npm events. npm logs an http-complete line when a response body ENDS (for an error status, when the status arrives);'
  + ' a request still in flight when the scanner stopped has no such line, several requests can be outstanding at once, and the last line is not evidence of which request, if any, stalled.';
/** The most retained bytes per graph. The receiving side refuses anything larger. */
export const DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
/** How much of a log's END is read. A log is never read whole just to be sliced. */
export const DIAGNOSTIC_READ_WINDOW = 2 * 1024 * 1024;
const DIAGNOSTIC_MAX_LINE = 2048;
/** Why a diagnostic is unavailable — a closed vocabulary, so no free text reaches a record. */
export const DIAGNOSTIC_REASONS = Object.freeze([
  'unsafe_location', // the log root is relative, a link, or inside something scanned or uploaded
  'setup_failed', // the per-scan log directory could not be created
  'no_log', // the scanner left no log in its directory
  'multiple_logs', // more than one file: which one to keep is not a choice made here
  'unsafe_entry', // a link, a directory, or a name npm does not write
  'unreadable', // the log could not be opened or read
  'write_failed', // the projection could not be written and verified in the evidence directory
  'capture_failed', // anything else — the scan's own result stands
]);
/** The one canonical, graph-bound file name a retained diagnostic may have. */
export const diagnosticFileName = (graph) => `${graph}.npm-diagnostics.txt`;
const LOG_NAME_RE = /^[0-9A-Za-z_-]{1,64}-debug-\d{1,4}\.log$/;
const BULK_PATH = '/-/npm/v1/security/advisories/bulk';
const unavailable = (reason) => ({ state: 'unavailable', reason });
const within = (child, parent) => {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};
const realOr = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * A fresh log directory for ONE scan, under an ABSOLUTE root that is neither inside nor
 * around anything in `forbidden` (the scanned directory, the evidence directory, the
 * candidate, the replay, the toolchains). npm resolves `--logs-dir` against ITS OWN cwd —
 * each graph's directory — so a relative value would write into the graph being scanned.
 */
function openLogsDir({ graph, root, forbidden }) {
  if (typeof root !== 'string' || root === '') return { reason: 'setup_failed' };
  if (!isAbsolute(root)) return { reason: 'unsafe_location' };
  let stat;
  try { stat = lstatSync(root); } catch { return { reason: 'setup_failed' }; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { reason: 'unsafe_location' };
  const realRoot = realpathSync(root);
  for (const path of forbidden) {
    if (typeof path !== 'string' || path === '') continue;
    const other = realOr(resolve(path));
    if (within(realRoot, other) || within(other, realRoot)) return { reason: 'unsafe_location' };
  }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(String(graph))) return { reason: 'setup_failed' };
  try { return { dir: mkdtempSync(join(realRoot, `${graph}-`)), root: realRoot }; } catch { return { reason: 'setup_failed' }; }
}

/** The last `window` bytes of a regular file, never following a link and never reading it whole. */
function readTail(path, window) {
  const fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('not a regular file');
    const start = Math.max(0, stat.size - window);
    const buffer = Buffer.alloc(stat.size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString('latin1'), sourceBytes: stat.size, readBytes: read, headUnread: start > 0 };
  } finally {
    closeSync(fd);
  }
}

/**
 * A URL as ONE safe token: scheme, host and a plain path. Credentials and any query or
 * fragment are replaced by a marker rather than dropped silently; anything unusual is
 * omitted whole.
 */
function safeUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return '<url-omitted>'; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !/^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(url.host)) return '<url-omitted>';
  const path = /^\/[A-Za-z0-9%._~@+/-]{0,512}$/.test(url.pathname) ? url.pathname : '/<path-omitted>';
  return `${url.protocol}//${url.username || url.password ? '<credentials-omitted>@' : ''}${url.host}${path}${url.search || url.hash ? '?<query-omitted>' : ''}`;
}

/** npm 11's debug-log lines that are KEPT, each re-rendered from validated fields. Nothing else is. */
const EVENTS = [
  [/^(\d{1,9}) info using (npm|node)@v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/, (m) => `${m[1]} using ${m[2]} ${m[3]}`],
  // npm logs these objects through util.inspect: a large one OPENS with a bare `{` and
  // continues on further lines (indented, or a closing `}`, which never match here); a small
  // one is a single `{ ... }` line, and an empty one is `{}`. The real pinned npm wrote the
  // single-line form in the probe release/README.md records. Only the event is kept — never
  // what the object held.
  [/^(\d{1,9}) silly audit bulk request \{(?:\}| .* \})?$/, (m) => `${m[1]} audit-bulk-request-start`],
  [/^(\d{1,9}) silly audit report (?:\{(?:\}| .* \})?|(null))$/, (m) => `${m[1]} ${m[2] === 'null' ? 'audit-report-absent' : 'audit-report-received'}`],
  [/^(\d{1,9}) silly packumentCache (?:corgi|full):(\S{1,2048}) cache-miss$/, (m) => `${m[1]} packument-request-start GET ${safeUrl(m[2])}`],
  [/^(\d{1,9}) http fetch ([A-Z]{3,7}) (\d{3}) (\S{1,2048}) (\d{1,9})ms(?: attempt #(\d{1,3}))?(?: \(cache ([a-z]{1,20})\))?$/,
    (m) => `${m[1]} http-complete ${m[2]} ${m[3]} ${safeUrl(m[4])} ${m[5]}ms${m[6] ? ` attempt-${m[6]}` : ''}${m[7] ? ` cache-${m[7]}` : ''}`],
  [/^(\d{1,9}) http cache (\S{1,2048}) (\d{1,9})ms(?: attempt #\d{1,3})? \(cache hit\)$/, (m) => `${m[1]} http-cache-hit ${safeUrl(m[2])} ${m[3]}ms`],
  [/^(\d{1,9}) http fetch ([A-Z]{3,7}) (\S{1,2048}) attempt (\d{1,3}) failed with ([A-Z0-9_]{1,40})$/,
    (m) => `${m[1]} http-attempt-failed ${m[2]} ${safeUrl(m[3])} attempt-${m[4]} ${m[5]}`],
  [/^(\d{1,9}) verbose audit error ([A-Za-z]{1,40}Error)\b/, (m) => `${m[1]} audit-error ${m[2]}`],
  [/^(\d{1,9}) verbose audit error\s+code: '([A-Z0-9_]{2,40})',?$/, (m) => `${m[1]} audit-error-code ${m[2]}`],
  [/^(\d{1,9}) verbose audit error\s+type: '([a-z][a-z-]{1,39})',?$/, (m) => `${m[1]} audit-error-type ${m[2]}`],
  [/^(\d{1,9}) warn audit request to (\S{1,2048}) failed, reason: (.{0,1024})$/, (m) => {
    const codes = [...new Set(m[3].match(/\bE[A-Z0-9_]{2,40}\b/g) ?? [])].slice(0, 3);
    return `${m[1]} audit-request-failed ${safeUrl(m[2])} ${codes.length ? codes.join(' ') : 'reason-omitted'}`;
  }],
  [/^(\d{1,9}) error audit endpoint returned an error$/, (m) => `${m[1]} audit-endpoint-error`],
  [/^(\d{1,9}) timing ([A-Za-z0-9:._-]{1,80}) Completed in (\d{1,9})ms$/, (m) => `${m[1]} timing ${m[2]} ${m[3]}ms`],
  [/^(\d{1,9}) verbose (exit|code) (-?\d{1,5})$/, (m) => `${m[1]} ${m[2]} ${m[3]}`],
];

function projectLine(line) {
  if (line.length > DIAGNOSTIC_MAX_LINE) return null;
  for (const [re, render] of EVENTS) {
    const m = re.exec(line);
    if (m) return render(m);
  }
  return null;
}

/**
 * The retained bytes: a fixed header, then as many of the LAST events as fit in
 * `maxBytes`. Printable ASCII and newlines only, by construction.
 */
function renderDiagnostics({ graph, text, sourceBytes, readBytes, headUnread, maxBytes }) {
  let lines = text.split('\n');
  if (headUnread) lines = lines.slice(1); // a window that starts mid-file starts mid-line
  if (lines.at(-1) === '') lines.pop();
  const events = [];
  let omitted = 0;
  for (const raw of lines) {
    const event = projectLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (event) events.push(event); else omitted += 1;
  }
  const header = (dropped) => [
    DIAGNOSTIC_HEADER,
    `# graph: ${graph}`,
    `# source: npm debug log, ${sourceBytes} bytes; ${headUnread ? `only its last ${readBytes} bytes were read` : 'read whole'}`,
    `# lines examined: ${lines.length}; kept as events: ${events.length - dropped}; omitted (not on the allowlist): ${omitted}; oldest events dropped to fit ${maxBytes} bytes: ${dropped}`,
    DIAGNOSTIC_READING,
  ].map((l) => `${l}\n`).join('');
  const budget = maxBytes - Buffer.byteLength(header(events.length));
  let kept = 0;
  let used = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const size = events[i].length + 1;
    if (used + size > budget) break;
    used += size;
    kept += 1;
  }
  // The budget above was measured with the header stating `kept 0 / dropped N`; the header
  // written states the REAL counts, which can be a few digits wider. Measure what is
  // actually written, and drop further oldest events until it fits. Bounded: the overshoot
  // is a few digits, and each drop removes a whole event line (>= 9 bytes) while the header
  // grows by at most one byte.
  const render = (d) => Buffer.from(header(d) + events.slice(d).map((e) => `${e}\n`).join(''), 'latin1');
  let dropped = events.length - kept;
  let bytes = render(dropped);
  while (bytes.length > maxBytes && dropped < events.length) {
    dropped += 1;
    bytes = render(dropped);
  }
  return { bytes, truncated: headUnread || dropped > 0 };
}

// THE FORMAT'S GRAMMAR — what a retained diagnostic may contain, line by line. Printable
// ASCII is necessary and NOT sufficient: a raw npm line (`9 verbose argv "--token=..."`) is
// printable too. Every line must be one of the five header lines, stating counts that agree
// with the events, or an event in EXACTLY the shape renderDiagnostics writes, with every
// URL in safeUrl's output form. The producer checks its own bytes against this before
// writing and the receiving side (release/lib/dependency-evidence.mjs) checks them again,
// so the two cannot disagree about what "sanitized" means.
const U = String.raw`(?:<url-omitted>|https?://(?:<credentials-omitted>@)?[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:/<path-omitted>|/[A-Za-z0-9%._~@+/-]{0,512})(?:\?<query-omitted>)?)`;
const EVENT_SHAPES = [
  String.raw`using (?:npm|node) \d{1,4}\.\d{1,4}\.\d{1,4}`,
  'audit-bulk-request-start',
  'audit-report-(?:received|absent)',
  `packument-request-start GET ${U}`,
  String.raw`http-complete [A-Z]{3,7} \d{3} ${U} \d{1,9}ms(?: attempt-\d{1,3})?(?: cache-[a-z]{1,20})?`,
  String.raw`http-cache-hit ${U} \d{1,9}ms`,
  String.raw`http-attempt-failed [A-Z]{3,7} ${U} attempt-\d{1,3} [A-Z0-9_]{1,40}`,
  '(?:audit-error [A-Za-z]{1,40}Error)',
  'audit-error-code [A-Z0-9_]{2,40}',
  'audit-error-type [a-z][a-z-]{1,39}',
  `audit-request-failed ${U} (?:reason-omitted|E[A-Z0-9_]{2,40}(?: E[A-Z0-9_]{2,40}){0,2})`,
  'audit-endpoint-error',
  String.raw`timing [A-Za-z0-9:._-]{1,80} \d{1,9}ms`,
  String.raw`(?:exit|code) -?\d{1,5}`,
];
const EVENT_LINE_RE = new RegExp(String.raw`^\d{1,9} (?:${EVENT_SHAPES.join('|')})$`);
const SOURCE_RE = /^# source: npm debug log, (\d{1,15}) bytes; (?:read whole|only its last (\d{1,9}) bytes were read)$/;
const COUNTS_RE = /^# lines examined: (\d{1,9}); kept as events: (\d{1,9}); omitted \(not on the allowlist\): (\d{1,9}); oldest events dropped to fit (\d{1,9}) bytes: (\d{1,9})$/;

/**
 * Is `bytes` a diagnostic this format could have produced for `graph`? Returns
 * {ok, truncated}: `truncated` is what the bytes themselves state (a partial read or
 * dropped events), for the caller to compare with a descriptor. Never throws.
 */
export function checkDiagnosticProjection(bytes, { graph }) {
  const no = { ok: false, truncated: null };
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'latin1');
  if (buf.length === 0 || buf.length > DIAGNOSTIC_MAX_BYTES || buf[buf.length - 1] !== 0x0a) return no;
  if (!buf.every((b) => b === 0x0a || (b >= 0x20 && b <= 0x7e))) return no;
  const lines = buf.toString('latin1').slice(0, -1).split('\n');
  if (lines.length < 5 || lines[0] !== DIAGNOSTIC_HEADER || lines[1] !== `# graph: ${graph}` || lines[4] !== DIAGNOSTIC_READING) return no;
  const source = SOURCE_RE.exec(lines[2]);
  const counts = COUNTS_RE.exec(lines[3]);
  if (!source || !counts) return no;
  const [examined, kept, omitted, fit, dropped] = counts.slice(1).map(Number);
  const events = lines.slice(5);
  if (events.length !== kept || kept + dropped + omitted !== examined || fit > DIAGNOSTIC_MAX_BYTES) return no;
  if (source[2] !== undefined && Number(source[2]) > DIAGNOSTIC_READ_WINDOW) return no;
  if (!events.every((e) => EVENT_LINE_RE.test(e))) return no;
  return { ok: true, truncated: source[2] !== undefined || dropped > 0 };
}

/**
 * Keep the scan's diagnostic: exactly one regular log file in this scan's own directory,
 * projected, written ONCE under its canonical name and verified by reading it back. Any
 * failure leaves no partial file behind and answers `unavailable` with a fixed reason.
 */
function captureDiagnostics({ graph, logsDir, root, evidenceDir, limits }) {
  let entries;
  try {
    const stat = lstatSync(logsDir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !within(realpathSync(logsDir), root)) return unavailable('unsafe_entry');
    entries = readdirSync(logsDir, { withFileTypes: true });
  } catch { return unavailable('unreadable'); }
  if (entries.length === 0) return unavailable('no_log');
  if (entries.some((e) => !e.isFile())) return unavailable('unsafe_entry');
  if (entries.length > 1) return unavailable('multiple_logs');
  if (!LOG_NAME_RE.test(entries[0].name)) return unavailable('unsafe_entry');
  let tail;
  try { tail = readTail(join(logsDir, entries[0].name), limits.readWindow); } catch { return unavailable('unreadable'); }
  const { bytes, truncated } = renderDiagnostics({ graph, ...tail, maxBytes: limits.maxBytes });
  if (bytes.length > limits.maxBytes) return unavailable('capture_failed');
  // Written only if the receiving side would accept it: the grammar is the one definition.
  const check = checkDiagnosticProjection(bytes, { graph });
  if (!check.ok || check.truncated !== truncated) return unavailable('capture_failed');
  const file = diagnosticFileName(graph);
  const path = join(evidenceDir, file);
  let created = false;
  try {
    writeFileSync(path, bytes, { flag: 'wx' });
    created = true;
    if (!readFileSync(path).equals(bytes)) throw new Error('the written diagnostic does not read back');
  } catch {
    if (created) { try { rmSync(path, { force: true }); } catch { /* reported as unavailable */ } }
    return unavailable('write_failed');
  }
  return { state: 'retained', file, sha256: sha256(bytes), bytes: bytes.length, truncated };
}

/**
 * Read a retained diagnostic back for a human: the last `last` events, and the requests
 * the log shows STARTING with no logged completion before it ends. The second list is
 * what the log records, not a finding — see the section comment above.
 */
export function readDiagnosticEvents(text, { last = 8, open = 5 } = {}) {
  const events = String(text).split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  const started = [];
  let bulk = 0;
  for (const e of events) {
    const t = e.split(' ');
    if (t[1] === 'packument-request-start') started.push(`${t[2]} ${t[3]}`);
    else if (t[1] === 'http-complete' || t[1] === 'http-cache-hit') {
      if (t[1] === 'http-complete' && t[2] === 'POST' && String(t[4]).endsWith(BULK_PATH)) bulk = Math.max(0, bulk - 1);
      const i = started.indexOf(t[1] === 'http-complete' ? `${t[2]} ${t[4]}` : `GET ${t[2]}`);
      if (i >= 0) started.splice(i, 1);
    } else if (t[1] === 'audit-bulk-request-start') bulk += 1;
    else if (['audit-report-received', 'audit-report-absent', 'audit-request-failed', 'audit-endpoint-error'].includes(t[1])) bulk = 0;
  }
  const unfinished = [...(bulk > 0 ? ['POST (the audit bulk advisory request)'] : []), ...started];
  return { count: events.length, last: events.slice(-last), unfinished: unfinished.slice(0, open), moreUnfinished: Math.max(0, unfinished.length - open) };
}

/**
 * Scan ONE graph with the pinned scanner and read the answer. Nothing is decided here.
 *
 * @param {object} input
 * @param {string} input.graph        label (application | scanner | publisher)
 * @param {string} input.dir          where the scanner runs
 * @param {object} input.inv          the inventory the answer is read against
 * @param {'retained'|'installed'} input.kind  how `dir` is proven unchanged by the scan
 * @param {Function} [input.scopeOf]  for an installed graph's re-inventory
 * @param {string} input.npmCli       the pinned scanner's npm-cli.js
 * @param {object} input.policy       the dependency-audit policy (scanner registry and timeout)
 * @param {Function} input.runner     the process runner
 * @param {Function} input.clock      () => ISO instant
 * @param {string} input.evidenceDir  where the raw output is written
 * @param {object} [input.env]        environment facts for an installed re-inventory
 * @param {object} [input.diagnostics] {root, forbidden?, limits?}: keep the scanner's
 *                                    sanitized log events. `root` is an
 *                                    ABSOLUTE directory the caller owns and removes;
 *                                    `forbidden` lists what it must not be inside or around
 */
export function collect({ graph, dir, inv, kind, scopeOf, npmCli, policy, runner, clock, evidenceDir, env, baseEnv = process.env, diagnostics = null }) {
  const problems = [...inv.problems];
  const before = kind === 'retained' ? replayState(dir) : inventory(dir, { graph, env, scopeOf }).digests;
  const { env: scanEnv } = scannerEnvironment(baseEnv);
  // THE DIAGNOSTIC HALF (see the section above). Absent `diagnostics`, nothing here runs and
  // the scan is invoked exactly as before; present, the scan gets ONE extra config key.
  let logs = null;
  let diagnostic;
  if (diagnostics) {
    try {
      const opened = openLogsDir({ graph, root: diagnostics.root, forbidden: [dir, evidenceDir, ...(diagnostics.forbidden ?? [])] });
      if (opened.dir) logs = opened; else diagnostic = unavailable(opened.reason);
    } catch { diagnostic = unavailable('setup_failed'); }
  }
  const startedAt = clock();
  const run = runner({
    command: process.execPath,
    args: [npmCli, ...scannerArgs(policy.scanner.registry), ...(logs ? [`--logs-dir=${logs.dir}`] : [])],
    cwd: dir,
    env: scanEnv,
    timeoutMs: policy.scanner.timeoutSeconds * 1000,
  });
  const finishedAt = clock();
  if (logs) {
    const limits = {
      readWindow: Math.min(DIAGNOSTIC_READ_WINDOW, diagnostics.limits?.readWindow ?? DIAGNOSTIC_READ_WINDOW),
      maxBytes: Math.min(DIAGNOSTIC_MAX_BYTES, diagnostics.limits?.maxBytes ?? DIAGNOSTIC_MAX_BYTES),
    };
    try { diagnostic = captureDiagnostics({ graph, logsDir: logs.dir, root: logs.root, evidenceDir, limits }); } catch { diagnostic = unavailable('capture_failed'); }
    try { rmSync(logs.dir, { recursive: true, force: true }); } catch { /* the caller removes the root it owns */ }
  }
  const after = kind === 'retained' ? replayState(dir) : inventory(dir, { graph, env, scopeOf }).digests;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    problems.push({ code: 'inventory_changed_during_audit', detail: `${graph}: what was scanned changed while it was being scanned — the answer describes nothing that still exists` });
  }
  const report = readReport({ graph, run, inv });
  problems.push(...report.problems);
  const stdoutFile = `${graph}.scanner-stdout.txt`;
  const stderrFile = `${graph}.scanner-stderr.txt`;
  writeFileSync(join(evidenceDir, stdoutFile), run.stdout ?? '');
  writeFileSync(join(evidenceDir, stderrFile), run.stderr ?? '');
  return {
    problems,
    findings: report.findings,
    record: {
      observation: inv.observation ?? INSTALLED_OBSERVATION,
      startedAt,
      finishedAt,
      digests: inv.digests,
      counts: inv.counts,
      run: {
        argv: [run.command, ...(run.args ?? [])],
        status: run.status,
        signal: run.signal,
        timedOut: run.timedOut,
        error: run.error,
        durationMs: run.durationMs,
        stdoutFile,
        stdoutSha256: sha256(run.stdout ?? ''),
        stdoutBytes: Buffer.byteLength(run.stdout ?? ''),
        stderrFile,
        stderrSha256: sha256(run.stderr ?? ''),
      },
      ...(diagnostics ? { diagnostics: diagnostic } : {}),
    },
  };
}
