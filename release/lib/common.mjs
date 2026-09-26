/**
 * Small shared vocabulary for the release records: canonical JSON, digests, the git blob
 * identity of a file, instants, and the release policy. Pure; no clock, no network.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { digestOf } from './tree.mjs';

export const SHA_RE = /^[0-9a-f]{40}$/;
export const HEX_RE = /^[0-9a-f]{64}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const ID_RE = /^[1-9][0-9]{0,19}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const isInstant = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
export const reason = (code, detail) => ({ code, detail: String(detail) });

/** Keys sorted by code unit, no insignificant whitespace — the form every record digest uses. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
  };
  return JSON.stringify(sort(value));
}
export const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
export const digestOfValue = (value) => digestOf(Buffer.from(canonicalJson(value), 'utf8'));

/** The object id git gives these bytes as a blob — what `git ls-tree` and the contents API report. */
export const gitBlobSha1 = (bytes) => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');

/** Parse JSON bytes into {ok, value} or {ok:false, detail}; never throws. */
export function parseJson(bytes) {
  try {
    return { ok: true, value: JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)) };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

/** A written record: pretty JSON with a trailing newline, so its bytes are what gets digested. */
export const recordBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

export const POLICY_SCHEMA = 'dinify.admin.release-policy/1';

/** The committed release policy, validated. Returns {policy, problems}; policy null on any problem. */
export function loadReleasePolicy(root) {
  let policy;
  try { policy = JSON.parse(readFileSync(join(root, 'release', 'policy.json'), 'utf8')); } catch (error) {
    return { policy: null, problems: [reason('release_policy_unreadable', error.message)] };
  }
  const problems = [];
  const p = (detail) => problems.push(reason('release_policy_invalid', detail));
  if (!isObject(policy)) return { policy: null, problems: [reason('release_policy_invalid', 'not an object')] };
  if (policy.schema !== POLICY_SCHEMA) p(`schema is not ${POLICY_SCHEMA}`);
  if (policy.repository !== 'mugak1/Dinify-Admin') p('repository is not mugak1/Dinify-Admin');
  const c = policy.certification;
  if (!isObject(c) || c.workflowPath !== '.github/workflows/ci.yml' || c.job !== 'validate' || c.event !== 'push'
      || c.ref !== 'refs/heads/main' || c.artifactPrefix !== 'admin-candidate') p('certification must name ci.yml/validate, push on refs/heads/main, prefix admin-candidate');
  const b = policy.build;
  if (!isObject(b) || b.configuration !== 'production' || b.command !== 'npm run build:prod' || b.outputPath !== 'dist' || !Number.isInteger(b.nodeMajor)) {
    p('build must be the production configuration, `npm run build:prod`, into dist, on one Node major');
  }
  const e = policy.evaluation;
  if (!isObject(e) || e.workflowPath !== '.github/workflows/deploy.yml' || e.admissionPrefix !== 'admin-admission') p('evaluation must name deploy.yml and prefix admin-admission');
  const f = policy.freshness;
  // 24 hours is the established maximum (D08). The policy may be stricter, never looser.
  if (!isObject(f) || !Number.isInteger(f.assessmentWindowHours) || f.assessmentWindowHours < 1 || f.assessmentWindowHours > 24
      || !Number.isInteger(f.dispatchMarginMinutes) || f.dispatchMarginMinutes < 5 || f.dispatchMarginMinutes > 120) {
    p('freshness.assessmentWindowHours must be 1..24 and dispatchMarginMinutes 5..120');
  }
  if (!isObject(policy.trusted) || !same(policy.trusted.paths, ['release', 'dependency-audit'])) p('trusted.paths must be ["release", "dependency-audit"]');
  const known = ['schema', 'repository', 'certification', 'build', 'evaluation', 'freshness', 'trusted'];
  for (const key of Object.keys(policy)) if (!known.includes(key)) p(`unknown field ${key}`);
  return { policy: problems.length ? null : policy, problems };
}

export const candidateArtifactName = (policy, runId, runAttempt) => `${policy.certification.artifactPrefix}-${runId}-${runAttempt}`;
export const admissionArtifactName = (policy, runId, runAttempt) => `${policy.evaluation.admissionPrefix}-${runId}-${runAttempt}`;
