/**
 * THE DEPENDENCY-AUDIT POLICY — one set of rules, applied identically in every Dinify
 * repository.
 *
 * This module is deliberately ecosystem-free. An adapter (npm.mjs here, pip_adapter.py in
 * Dinify-Backend) turns a scanner's raw output into NORMALIZED FINDINGS; this module turns
 * normalized findings plus the committed disposition records into ONE outcome. The Python
 * port in Dinify-Backend implements the same rules, and `conformance.json` — byte-identical
 * in all three repositories — is the oracle both are tested against. Change a rule here and
 * the vectors fail until the same change lands in the other ecosystem.
 *
 * FOUR OUTCOMES, and they are not shades of one another:
 *
 *   within_policy    the audit completed and nothing the policy blocks was found
 *   exceptions_only  the audit completed and passes ONLY because of specifically approved,
 *                    still-valid exception records — visible, never reported as clean
 *   blocking         the audit completed and found something the policy blocks, or a
 *                    disposition record was refused (expired, malformed, broadened,
 *                    mismatched, unused)
 *   incomplete       no trustworthy result exists: the scanner, the collection, the parse,
 *                    the inventory binding or the provenance failed, or a finding could not
 *                    be classified. An empty report is NOT a clean report.
 *
 * THE RULES (the parent policy, D08 Stage B §6):
 *   - a CRITICAL or HIGH advisory blocks, whatever the scope — a build, test or publisher
 *     tool is not excused by being a devDependency;
 *   - ANY advisory on a RUNTIME/shipped package blocks, whatever the severity;
 *   - a MODERATE, LOW or INFO advisory confined to executable TOOLING is visible and needs
 *     an explicit triage record (owner, reason, expiry). Untriaged it does not block, but it
 *     is counted and reported as TRIAGE REQUIRED — it is never a zero-findings result;
 *   - anything else (unknown severity on tooling, unknown scope below high) cannot be
 *     evaluated, and a policy that cannot be evaluated has not passed: incomplete.
 *
 * Nothing here reads the network, the clock or the filesystem. `now` is an argument.
 */

export const OUTCOMES = Object.freeze(['within_policy', 'exceptions_only', 'blocking', 'incomplete']);
export const SEVERITIES = Object.freeze(['critical', 'high', 'moderate', 'low', 'info']);
export const SCOPES = Object.freeze(['runtime', 'tooling']);
export const RECORD_KINDS = Object.freeze(['exception', 'triage']);

/** A record may not outlive its approval by more than this. Bounded, never open-ended. */
export const MAX_RECORD_DAYS = 90;
export const MIN_TEXT = 20;

const EXIT = Object.freeze({ within_policy: 0, exceptions_only: 0, blocking: 1, incomplete: 2 });
export const exitCodeFor = (outcome) => (outcome in EXIT ? EXIT[outcome] : 2);

const RECORD_KEYS = ['id', 'kind', 'advisory', 'aliases', 'package', 'version', 'paths', 'scope',
  'applicability', 'reason', 'owner', 'approval', 'expires'];
const APPROVAL_KEYS = ['by', 'reference', 'date'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const ADVISORY_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,127}$/;
// An EXACT version. Ranges, wildcards, tags and whitespace are how an exception quietly
// broadens to versions nobody reviewed.
const VERSION_RE = /^[0-9]+(\.[0-9]+)+([-+.!][0-9A-Za-z.+!-]+)?$/;
const PATH_RE = /^(application|scanner):[^\s*?[\]{}]+$/;
const REFERENCE_RE = /^https:\/\/github\.com\/mugak1\/[A-Za-z0-9._-]+\/(pull|issues)\/[0-9]+(#[A-Za-z0-9_-]+)?$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** A calendar date, or null. `2026-02-30` is not a date, whatever Date.parse thinks. */
export function parseDate(text) {
  if (typeof text !== 'string') return null;
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

const DAY = 86400000;
const isText = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;

/**
 * Structural validation of ONE disposition record. Returns the list of problems; an empty
 * list means the record is well-formed and in date at `nowMs`. Whether it APPLIES is a
 * separate question, answered against the findings.
 */
export function validateRecord(record, nowMs) {
  const problems = [];
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return ['record is not an object'];
  for (const key of Object.keys(record)) if (!RECORD_KEYS.includes(key)) problems.push(`unknown field "${key}"`);
  for (const key of RECORD_KEYS) if (!(key in record)) problems.push(`missing field "${key}"`);
  if (!(typeof record.id === 'string' && ID_RE.test(record.id))) problems.push('id is not a valid identifier');
  if (!RECORD_KINDS.includes(record.kind)) problems.push(`kind must be one of ${RECORD_KINDS.join(', ')}`);
  if (!(typeof record.advisory === 'string' && ADVISORY_RE.test(record.advisory))) problems.push('advisory is not an exact advisory identifier');
  if (!Array.isArray(record.aliases) || !record.aliases.every((a) => typeof a === 'string' && ADVISORY_RE.test(a))) {
    problems.push('aliases must be a list of exact advisory identifiers (it may be empty)');
  }
  if (!(typeof record.package === 'string' && /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/.test(record.package))) problems.push('package is not an exact package name');
  if (!(typeof record.version === 'string' && VERSION_RE.test(record.version))) problems.push('version is not one exact version');
  if (!Array.isArray(record.paths) || record.paths.length === 0 || !record.paths.every((p) => typeof p === 'string' && PATH_RE.test(p))) {
    problems.push('paths must be a non-empty list of exact graph paths');
  } else if (new Set(record.paths).size !== record.paths.length) {
    problems.push('paths repeats an entry');
  }
  if (!SCOPES.includes(record.scope)) problems.push(`scope must be one of ${SCOPES.join(', ')}`);
  if (!isText(record.applicability, MIN_TEXT)) problems.push(`applicability evidence must be at least ${MIN_TEXT} characters`);
  if (!isText(record.reason, MIN_TEXT)) problems.push(`reason must be at least ${MIN_TEXT} characters`);
  if (!isText(record.owner)) problems.push('owner is required');
  const approval = record.approval;
  let approvedMs = null;
  if (approval === null || typeof approval !== 'object' || Array.isArray(approval)) {
    problems.push('approval must record who approved it, where, and when');
  } else {
    for (const key of Object.keys(approval)) if (!APPROVAL_KEYS.includes(key)) problems.push(`unknown approval field "${key}"`);
    if (!isText(approval.by)) problems.push('approval.by is required');
    if (!(typeof approval.reference === 'string' && REFERENCE_RE.test(approval.reference))) {
      problems.push('approval.reference must link the review that approved it (a mugak1 pull request or issue)');
    }
    approvedMs = parseDate(approval.date);
    if (approvedMs === null) problems.push('approval.date is not a calendar date');
  }
  const expiresMs = parseDate(record.expires);
  if (expiresMs === null) problems.push('expires is not a calendar date');
  const todayMs = Math.floor(nowMs / DAY) * DAY;
  if (approvedMs !== null && approvedMs > todayMs) problems.push('approval.date is in the future');
  if (approvedMs !== null && expiresMs !== null) {
    if (expiresMs <= approvedMs) problems.push('expires is not after approval.date');
    else if ((expiresMs - approvedMs) / DAY > MAX_RECORD_DAYS) problems.push(`expires is more than ${MAX_RECORD_DAYS} days after approval.date`);
  }
  // Valid THROUGH the day before `expires`; from 00:00 UTC on that date it has lapsed.
  if (expiresMs !== null && nowMs >= expiresMs) problems.push(`expired on ${record.expires}`);
  return problems;
}

/** The policy decision for ONE finding, before any record is considered. */
export function classify(finding) {
  const severity = SEVERITIES.includes(finding.severity) ? finding.severity : 'unknown';
  const scope = SCOPES.includes(finding.scope) ? finding.scope : 'unknown';
  if (severity === 'critical' || severity === 'high') return 'blocking';
  if (scope === 'runtime') return 'blocking';
  if (scope === 'tooling' && severity !== 'unknown') return 'triage';
  return 'unresolved';
}

const advisoryMatches = (record, finding) => {
  const fAliases = Array.isArray(finding.aliases) ? finding.aliases : [];
  const rAliases = Array.isArray(record.aliases) ? record.aliases : [];
  return record.advisory === finding.advisory
    || fAliases.includes(record.advisory)
    || rAliases.includes(finding.advisory);
};

const FINDING_KEYS = ['advisory', 'package', 'version', 'path', 'scope', 'severity'];

/** A finding the adapter could not fill in completely is not something to decide on. */
function findingProblems(finding, index) {
  if (finding === null || typeof finding !== 'object') return [`finding ${index} is not an object`];
  const missing = FINDING_KEYS.filter((k) => typeof finding[k] !== 'string' || finding[k] === '');
  return missing.length ? [`finding ${index} lacks ${missing.join(', ')}`] : [];
}

/**
 * Evaluate normalized findings against the disposition records.
 *
 * @param {object} input
 * @param {Array<{code:string, detail:string}>} input.incomplete  collection/adapter failures
 * @param {Array<object>} input.findings  one per (advisory, installed node)
 * @param {Array<object>} input.records   the committed exception and triage records
 * @param {string} input.now              ISO instant the decision is made at
 */
export function evaluate({ incomplete = [], findings = [], records = [], now }) {
  const nowMs = Date.parse(now);
  const reasons = [];
  for (const item of incomplete) reasons.push({ outcome: 'incomplete', code: item.code, detail: item.detail });
  if (!Number.isFinite(nowMs)) reasons.push({ outcome: 'incomplete', code: 'clock', detail: 'the decision time is not an instant' });
  if (!Array.isArray(findings)) reasons.push({ outcome: 'incomplete', code: 'findings', detail: 'findings is not a list' });
  if (!Array.isArray(records)) reasons.push({ outcome: 'incomplete', code: 'records', detail: 'records is not a list' });

  const list = Array.isArray(findings) ? findings : [];
  const recs = Array.isArray(records) ? records : [];

  // ── findings ──
  const decided = list.map((finding, index) => {
    const problems = findingProblems(finding, index);
    for (const p of problems) reasons.push({ outcome: 'incomplete', code: 'finding_malformed', detail: p });
    const cls = problems.length ? 'unresolved' : classify(finding);
    return { ...finding, class: cls, disposition: 'open', coveredBy: null };
  });
  for (const f of decided) {
    if (f.class === 'unresolved') {
      reasons.push({ outcome: 'incomplete', code: 'unresolved_finding',
        detail: `${f.advisory ?? '?'} on ${f.path ?? '?'}: severity "${f.severity ?? '?'}" / scope "${f.scope ?? '?'}" cannot be evaluated by the policy` });
    }
  }

  // ── records ──
  // An id names ONE decision. Every record sharing an id is refused, not just the later
  // one — otherwise which of two contradictory approvals applied would depend on order.
  const idOf = (record) => (record && typeof record.id === 'string' ? record.id : '(no id)');
  const idCount = new Map();
  for (const record of recs) idCount.set(idOf(record), (idCount.get(idOf(record)) ?? 0) + 1);
  const checked = recs.map((record) => {
    const problems = Number.isFinite(nowMs) ? validateRecord(record, nowMs) : ['cannot be dated'];
    const id = idOf(record);
    if (idCount.get(id) > 1) problems.push('duplicate id');
    return { id, record, problems, usedPaths: new Set(), applied: 0 };
  });

  for (const entry of checked) {
    if (entry.problems.length) continue;
    const r = entry.record;
    const related = decided.filter((f) => f.package === r.package && advisoryMatches(r, f));
    if (related.length === 0) {
      entry.problems.push('matches no current finding (stale: remove it)');
      continue;
    }
    for (const f of related) {
      if (!r.paths.includes(f.path)) continue;
      if (f.version !== r.version) { entry.problems.push(`version ${r.version} does not match ${f.version} at ${f.path}`); continue; }
      if (f.scope !== r.scope) { entry.problems.push(`scope ${r.scope} does not match ${f.scope} at ${f.path}`); continue; }
      if (f.class === 'unresolved') { entry.problems.push(`${f.path} is unresolved and cannot be excepted`); continue; }
      const wants = f.class === 'blocking' ? 'exception' : 'triage';
      if (r.kind !== wants) { entry.problems.push(`a ${r.kind} record cannot cover a ${f.class} finding at ${f.path}`); continue; }
      entry.usedPaths.add(f.path);
    }
    for (const p of r.paths) if (!entry.usedPaths.has(p)) entry.problems.push(`path ${p} matches no current finding for ${r.advisory} (broadened or stale)`);
  }

  // Apply only records that survived every check. A refused record covers nothing.
  for (const entry of checked) {
    if (entry.problems.length) continue;
    const r = entry.record;
    for (const f of decided) {
      if (f.package !== r.package || !advisoryMatches(r, f) || !r.paths.includes(f.path)) continue;
      if (f.coveredBy) { entry.problems.push(`${f.path} is already covered by ${f.coveredBy}`); continue; }
      f.coveredBy = r.id;
      f.disposition = r.kind === 'exception' ? 'excepted' : 'triaged';
      entry.applied += 1;
    }
  }
  // A record that lost a path to a duplicate is refused, and so is what it covered.
  for (const entry of checked) {
    if (!entry.problems.length) continue;
    for (const f of decided) {
      if (f.coveredBy === entry.id) { f.coveredBy = null; f.disposition = 'open'; }
    }
  }

  for (const entry of checked) {
    if (entry.problems.length) {
      reasons.push({ outcome: 'blocking', code: 'record_refused', detail: `${entry.id}: ${entry.problems.join('; ')}` });
    }
  }
  for (const f of decided) {
    if (f.class === 'blocking' && f.disposition === 'open') {
      reasons.push({ outcome: 'blocking', code: 'blocking_finding',
        detail: `${f.advisory} (${f.severity}) on ${f.package}@${f.version} at ${f.path} [${f.scope}]` });
    }
  }

  const counts = {
    findings: decided.length,
    blocking: decided.filter((f) => f.class === 'blocking' && f.disposition === 'open').length,
    excepted: decided.filter((f) => f.disposition === 'excepted').length,
    triageRequired: decided.filter((f) => f.class === 'triage' && f.disposition === 'open').length,
    triaged: decided.filter((f) => f.disposition === 'triaged').length,
    unresolved: decided.filter((f) => f.class === 'unresolved').length,
    refusedRecords: checked.filter((e) => e.problems.length).length,
    appliedRecords: checked.filter((e) => !e.problems.length && e.applied > 0).length,
  };

  let outcome;
  if (reasons.some((r) => r.outcome === 'incomplete')) outcome = 'incomplete';
  else if (reasons.some((r) => r.outcome === 'blocking')) outcome = 'blocking';
  else if (counts.excepted > 0) outcome = 'exceptions_only';
  else outcome = 'within_policy';

  return {
    outcome,
    exitCode: exitCodeFor(outcome),
    counts,
    reasons,
    findings: decided,
    records: checked.map((e) => ({ id: e.id, status: e.problems.length ? 'refused' : 'applied', problems: e.problems, covers: e.applied })),
  };
}

/** One sentence that cannot be mistaken for "no vulnerabilities". */
export function headline(result) {
  const c = result.counts;
  const tail = [];
  if (c.findings === 0) tail.push('no advisories reported for the audited inventory');
  else tail.push(`${c.findings} advisory finding(s)`);
  if (c.blocking) tail.push(`${c.blocking} BLOCKING`);
  if (c.excepted) tail.push(`${c.excepted} under approved exception`);
  if (c.triageRequired) tail.push(`${c.triageRequired} lower-severity tooling finding(s) REQUIRE TRIAGE (not zero findings)`);
  if (c.triaged) tail.push(`${c.triaged} triaged`);
  if (c.unresolved) tail.push(`${c.unresolved} UNRESOLVED`);
  if (c.refusedRecords) tail.push(`${c.refusedRecords} disposition record(s) REFUSED`);
  const label = {
    within_policy: 'AUDIT COMPLETE — WITHIN POLICY',
    exceptions_only: 'AUDIT COMPLETE — PASSES ONLY WITH APPROVED EXCEPTIONS',
    blocking: 'AUDIT COMPLETE — BLOCKING',
    incomplete: 'AUDIT UNAVAILABLE OR INCOMPLETE — NOT A CLEAN RESULT',
  }[result.outcome] ?? 'AUDIT OUTCOME UNKNOWN';
  return `${label}: ${tail.join('; ')}`;
}
