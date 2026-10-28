/**
 * THE CLOCK — when an advisory became reportable, read from GitHub's own record of it
 * (CI-signal A-2).
 *
 * The dated obligation (core.mjs) defers an inherited HIGH tooling finding until 00:00 UTC
 * on `reportableSince` + HIGH_DEFERRAL_DAYS. This module supplies `reportableSince`, and
 * nothing else: the UTC calendar date of the advisory's `github_reviewed_at`, else of its
 * `published_at`, as `GET https://api.github.com/advisories/{ghsa_id}` states them.
 *
 * FIVE RULES, each the conservative direction:
 *   - NO ANSWER, NO DATE. A request that fails, times out, is refused, is rate-limited,
 *     answers anything but 200, or answers a body that is not this advisory's record
 *     leaves the finding with no date — so it blocks, exactly as it did before A-2. An
 *     outage falls back to blocking; it never falls back to deferral, and it is not an
 *     incomplete audit either: the scan itself completed.
 *   - THE ANSWER IS RETAINED. The raw bodies are written to `advisories.json` beside the
 *     scanner output, each with its digest, and the file's own digest is recorded in the
 *     collection. Every later decision — `evaluate`, the certification stamp, a promotion's
 *     privileged re-decision — reads the dates from that file and never fetches, so it
 *     reproduces offline. A file whose bytes are not the recorded ones is a TAMPERED
 *     record of what was answered: incomplete, never "no date".
 *   - DATES ATTACH ONLY WHERE PROVENANCE WAS ESTABLISHED. A finding with no `provenance`
 *     (a graph with no base, or the publisher toolchain at promotion) is never given a
 *     date, and its advisory is not even asked about. A run with no base therefore makes
 *     no request and writes exactly what it wrote before A-2.
 *   - ONLY WHAT A DATE CAN DEFER IS ASKED ABOUT. A date changes the decision for exactly
 *     one kind of finding: an INHERITED HIGH TOOLING one (core.mjs's deferral rule); for
 *     every other finding it decides nothing. So only those advisories are asked about
 *     (`awaitsDate`). A finding not asked about simply carries no date, as before.
 *   - A DATE ALREADY RETAINED IS REUSED, NOT ASKED AGAIN. A GitHub review or publication
 *     date does not change, and a candidate's certification retained the answers it was
 *     given, digest-bound in its evidence. A promotion takes each date from that record
 *     first (`answersFrom`) and asks only for the advisories it lacks; every answer in the
 *     record it writes says where it came from (`source`).
 *
 * The request is made by a CHILD PROCESS running this file, so the rest of the audit stays
 * synchronous; the token, when there is one, reaches only that child. `GH_TOKEN` is the
 * job's read-only token where a workflow supplies one. The endpoint is public, so a run
 * without one asks unauthenticated, at GitHub's lower rate limit — and a refusal there is
 * an ordinary "no date". A token never shares a process with the scanner or with any
 * candidate code: where a step runs the scanner it holds no token (the scanner's own
 * environment is scrubbed of one too, npm.mjs `scannerEnvironment`), and a promotion that
 * asks with a token does so from a SEPARATE step that runs only this repository's code.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ADVISORIES_SCHEMA = 'dinify.dependency-audit.advisories/v1';
export const ADVISORIES_FILE = 'advisories.json';
export const ADVISORY_ENDPOINT = 'https://api.github.com/advisories/';
/** GitHub prints advisory ids as `GHSA-xxxx-xxxx-xxxx`, which is how npm.mjs normalises them. */
export const GHSA_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
export const REQUEST_TIMEOUT_MS = 15_000;
/** A larger answer is not stored or read: no advisory record is anywhere near this size. */
export const MAX_BODY_BYTES = 1024 * 1024;
const MAX_IDS = 500;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const HEX_RE = /^[0-9a-f]{64}$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * The UTC calendar date of an ISO 8601 instant, or null. Strict: `Date.parse` alone reads
 * `2026-02-30T00:00:00Z` as 2 March, and a date nobody wrote is not one to defer on.
 */
export function utcDateOf(text) {
  if (typeof text !== 'string') return null;
  const m = INSTANT_RE.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  if (m[7] !== 'Z' && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * When an advisory became reportable, from ONE raw answer: the UTC date of
 * `github_reviewed_at`, else of `published_at`. Null when the body is not this advisory's
 * record, or when the field it would use is present but not an instant — a malformed
 * reviewed date is not replaced by the published one, because the rule names the reviewed
 * date first and an unreadable one establishes nothing.
 */
export function reportableDate(body, id) {
  if (typeof body !== 'string') return null;
  let doc;
  try { doc = JSON.parse(body); } catch { return null; }
  if (!isMapping(doc) || doc.ghsa_id !== id) return null;
  for (const key of ['github_reviewed_at', 'published_at']) {
    const value = doc[key];
    if (value === undefined || value === null) continue;
    return utcDateOf(value);
  }
  return null;
}

/**
 * Could a date defer this finding? Every precondition of core.mjs's `deferralDeadline`
 * except the date itself: tooling scope, high severity, inherited provenance — and a GHSA
 * advisory, the only kind GitHub can be asked about. For any other finding a date decides
 * nothing (it blocks, or is triaged, whatever the date), so it is not asked about.
 */
export function awaitsDate(finding) {
  return isMapping(finding) && finding.scope === 'tooling' && finding.severity === 'high' && finding.provenance === 'inherited'
    && typeof finding.advisory === 'string' && GHSA_RE.test(finding.advisory);
}

/**
 * The advisories to ask about: the GHSA identifiers of the findings a date could defer
 * (`awaitsDate`). Sorted and distinct, so the question — and the file that records its
 * answer — does not depend on the order the scanner listed them in.
 */
export function advisoryIds(findings) {
  const ids = new Set();
  for (const f of Array.isArray(findings) ? findings : []) if (awaitsDate(f)) ids.add(f.advisory);
  return [...ids].sort();
}

/** One answer, exactly as the child reports it, or an error answer when it is not that. */
function answerOf(raw, id) {
  if (!isMapping(raw) || raw.id !== id) return { id, status: 0, retrievedAt: null, error: 'no_answer', body: null };
  const status = Number.isInteger(raw.status) && raw.status >= 0 && raw.status <= 599 ? raw.status : 0;
  const retrievedAt = typeof raw.retrievedAt === 'string' ? raw.retrievedAt : null;
  let error = typeof raw.error === 'string' && raw.error !== '' ? raw.error.slice(0, 200) : null;
  let body = null;
  if (typeof raw.body === 'string') {
    if (Buffer.byteLength(raw.body) <= MAX_BODY_BYTES) body = raw.body;
    else error ??= 'body_too_large';
  } else if (raw.body !== null && raw.body !== undefined) {
    error ??= 'malformed_answer';
  }
  return { id, status, retrievedAt, error, body };
}

/**
 * Ask GitHub, once per advisory, in a child process. Never throws: anything that goes
 * wrong is an answer without a usable body, which is a finding without a date.
 *
 * @param {string[]} ids
 * @param {object} [options]
 * @param {string} [options.token]  defaults to GH_TOKEN; absent means unauthenticated
 * @returns {{answers: object[], authenticated: boolean}}
 */
export function fetchAdvisories(ids, { token = process.env.GH_TOKEN ?? '' } = {}) {
  const asked = ids.slice(0, MAX_IDS);
  const authenticated = typeof token === 'string' && token !== '';
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  if (authenticated) env.GH_TOKEN = token;
  let parsed = null;
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fetch', ...asked], {
      env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: asked.length * (REQUEST_TIMEOUT_MS + 1_000) + 10_000,
    });
    if (r.status === 0) parsed = JSON.parse(r.stdout);
  } catch { parsed = null; }
  const byId = new Map((Array.isArray(parsed) ? parsed : []).filter(isMapping).map((a) => [a.id, a]));
  return { answers: ids.map((id) => answerOf(byId.get(id), id)), authenticated };
}

/**
 * The retained record of what was asked and what came back. Returns its bytes and digest;
 * the digest is what the collection records and what every reader checks first. An answer
 * that says where it came from (`source`: `certification` or `fetched`) keeps that in the
 * record; one that does not is written exactly as before.
 */
export function buildAdvisoryEvidence({ answers, authenticated }) {
  const doc = {
    schema: ADVISORIES_SCHEMA,
    endpoint: ADVISORY_ENDPOINT,
    authenticated: authenticated === true,
    advisories: answers.map((a) => ({
      id: a.id,
      status: a.status,
      retrievedAt: a.retrievedAt,
      error: a.error,
      bodySha256: a.body === null ? null : sha256(a.body),
      body: a.body,
      ...(typeof a.source === 'string' ? { source: a.source } : {}),
    })),
  };
  const bytes = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
  return { doc, bytes, sha256: sha256(bytes) };
}

/**
 * Read a retained `advisories.json` against the digest recorded for it. Returns
 * {problems, dates}: `problems` are INCOMPLETE reasons (the record is not the one that was
 * written), and `dates` maps each advisory to its reportable date or null.
 *
 * @param {Buffer|string|undefined} bytes
 * @param {string} recorded  the sha256 the collection (or assessment) recorded
 */
export function readAdvisoryEvidence(bytes, recorded) {
  const problems = [];
  const dates = new Map();
  const bad = (code, detail) => { problems.push({ code, detail: `${ADVISORIES_FILE}: ${detail}` }); return { problems, dates: new Map() }; };
  if (bytes === undefined || bytes === null) return bad('advisories_missing', 'the advisory record the collection names is not retained');
  if (typeof recorded !== 'string' || !HEX_RE.test(recorded)) return bad('advisories_malformed', 'no digest is recorded for it');
  if (sha256(bytes) !== recorded) return bad('advisories_tampered', 'the bytes are not the ones that were recorded — the dates they carry are not the ones that were answered');
  let doc;
  try { doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)); } catch (error) { return bad('advisories_malformed', error.message); }
  if (!isMapping(doc) || doc.schema !== ADVISORIES_SCHEMA || doc.endpoint !== ADVISORY_ENDPOINT || typeof doc.authenticated !== 'boolean' || !Array.isArray(doc.advisories)) {
    return bad('advisories_malformed', 'not an advisory record this audit writes');
  }
  for (const a of doc.advisories) {
    if (!isMapping(a) || typeof a.id !== 'string' || !GHSA_RE.test(a.id) || !Number.isInteger(a.status)) return bad('advisories_malformed', 'an entry is not an answer about one advisory');
    if (dates.has(a.id)) return bad('advisories_malformed', `${a.id} is answered twice`);
    if (a.body !== null && (typeof a.body !== 'string' || a.bodySha256 !== sha256(a.body))) return bad('advisories_tampered', `${a.id}: the body is not the one whose digest was recorded`);
    if (a.body === null && a.bodySha256 !== null) return bad('advisories_malformed', `${a.id}: a digest is recorded for no body`);
    dates.set(a.id, a.status === 200 ? reportableDate(a.body, a.id) : null);
  }
  return { problems, dates };
}

/**
 * The answers a RETAINED record already holds for `ids`, read through `readAdvisoryEvidence`
 * against the digest recorded for it — so a record that is not the one that was written
 * contributes nothing and is reported. With `requireDate`, only an answer that yields a
 * date is taken (an earlier refusal or timeout is asked again rather than reused); without
 * it, any recorded answer is (a fresh refusal is still the answer that was given).
 *
 * @param {Buffer|string|undefined} bytes  the retained record, or nothing if none was
 * @param {string} recorded                the sha256 recorded for it
 * @param {string[]} ids                   the advisories wanted
 * @param {object} options
 * @param {string} options.source          stamped on every answer taken (`certification`, `fetched`)
 * @param {boolean} [options.requireDate]
 * @returns {{answers: object[], missing: string[], problems: object[], authenticated: boolean}}
 */
export function answersFrom(bytes, recorded, ids, { source, requireDate = false }) {
  const want = [...new Set(ids)].sort();
  if (bytes === undefined || bytes === null) return { answers: [], missing: want, problems: [], authenticated: false };
  const read = readAdvisoryEvidence(bytes, recorded);
  if (read.problems.length) return { answers: [], missing: want, problems: read.problems, authenticated: false };
  const doc = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  const byId = new Map(doc.advisories.map((a) => [a.id, a]));
  const answers = [];
  const missing = [];
  for (const id of want) {
    const a = byId.get(id);
    if (a && (!requireDate || typeof read.dates.get(id) === 'string')) {
      answers.push({ id, status: a.status, retrievedAt: a.retrievedAt, error: a.error, body: a.body, source });
    } else {
      missing.push(id);
    }
  }
  return { answers, missing, problems: [], authenticated: doc.authenticated };
}

/**
 * One record from the answers a promotion assembled for `ids`: those REUSED from the
 * certification, those FETCHED by the separate token-holding step, and — for an advisory
 * neither supplied — an explicit `no_answer` entry, so the record names every advisory it
 * was meant to date. `authenticated` is true only when every answer in it came from a
 * request that carried a token.
 */
export function assembleAdvisoryEvidence(ids, { reused, fetched }) {
  const byId = new Map();
  for (const a of [...fetched.answers, ...reused.answers]) byId.set(a.id, a);
  const answers = [...new Set(ids)].sort().map((id) => byId.get(id) ?? { id, status: 0, retrievedAt: null, error: 'no_answer', body: null, source: 'none' });
  const authenticated = answers.length > 0
    && (reused.answers.length === 0 || reused.authenticated === true)
    && (fetched.answers.length === 0 || fetched.authenticated === true)
    && answers.every((a) => a.source !== 'none');
  return buildAdvisoryEvidence({ answers, authenticated });
}

/**
 * Give each finding whose provenance was established the date its advisory became
 * reportable, where one is. Every other finding is returned unchanged.
 */
export function applyDates(findings, dates) {
  return findings.map((f) => {
    if (!isMapping(f) || typeof f.provenance !== 'string') return f;
    const date = dates.get(f.advisory);
    return typeof date === 'string' ? { ...f, reportableSince: date } : f;
  });
}

// ── the child: one GET per advisory, sequentially, each bounded ─────────────────────

async function fetchInChild(ids) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dinify-dependency-audit',
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const out = [];
  for (const id of ids) {
    const retrievedAt = new Date().toISOString();
    if (!GHSA_RE.test(id)) { out.push({ id, status: 0, retrievedAt, error: 'not_a_ghsa_id', body: null }); continue; }
    try {
      const res = await fetch(`${ADVISORY_ENDPOINT}${id}`, { headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const body = await res.text();
      out.push({ id, status: res.status, retrievedAt, error: null, body });
    } catch (error) {
      out.push({ id, status: 0, retrievedAt, error: error?.name === 'TimeoutError' ? 'timeout' : `request_failed: ${error?.cause?.code ?? error?.name ?? 'error'}`, body: null });
    }
  }
  process.stdout.write(JSON.stringify(out));
}

// Run as a script only by fetchAdvisories. No top-level await, so importing this module
// stays synchronous.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--fetch') {
  fetchInChild(process.argv.slice(3)).catch(() => { process.exitCode = 1; });
}
