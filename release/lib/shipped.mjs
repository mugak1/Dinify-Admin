/**
 * SHIPPED — does a forward move change anything Admin ships, and is the served release
 * still a safe place to stay? The deploy's forward-only guard asks this ONLY after it has
 * established that the automatic target descends from the commit the public origin serves.
 *
 * WHY. Dinify-Frontend's release-readiness evaluation approves exact Admin commits, and
 * every move of the served commit turns it red until a reviewed refresh approves the new
 * one. A merge that changes no shipped input (documentation, the dependency-audit policy,
 * the Claude workflows) used to move the served commit all the same. Now it leaves the
 * served commit — and so any approval of it — where they were. Nothing here approves
 * anything: it only declines to move.
 *
 * THE RULE, conservative by construction:
 *   1. A path is NOT SHIPPED only if it is on the explicit allowlist below AND on none of
 *      the always-shipped rules, which win. Everything else counts as shipped.
 *   2. Only a REGULAR FILE (100644 / 100755 blob) can be skipped. A symlink, submodule or
 *      anything else at an allowlisted path counts as shipped.
 *   3. Both sides of every change are judged: a rename out of src/ is shipped.
 *   4. A skip also needs the SERVED commit's certified candidate to be retained with at
 *      least RETENTION_MIN_DAYS left, so a run of documentation-only merges can never leave
 *      the certified rollback (or Dinify-Frontend's journey gate) pointing at an artifact
 *      about to expire. A served commit with no readable, sufficiently retained candidate
 *      deploys.
 *   5. Anything this module cannot establish — an unreadable, truncated or malformed tree,
 *      a missing listing — is DEPLOY, never skip. The caller treats a crash the same way.
 *
 * The allowlist lives in the trusted verifier (release/ at the workflow's own revision),
 * and release/lib/ is shipped by default: a change to this file always deploys.
 *
 * Pure: no clock (`now` is an argument), no filesystem, no network.
 */

import { selectCertification } from './admission.mjs';
import { SHA_RE, isObject } from './common.mjs';

export const SHIPPED_CHANGE_SCHEMA = 'dinify.admin.shipped-change/1';
export const RETENTION_MIN_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ALWAYS SHIPPED — wins over the allowlist. Basename rules apply at any depth. */
export const ALWAYS_SHIPPED = Object.freeze({
  prefixes: Object.freeze(['src/', 'public/', 'dependency-audit/scanner/']),
  exact: Object.freeze(['.github/workflows/ci.yml', '.github/workflows/deploy.yml']),
  basenames: Object.freeze([/^package[^/]*\.json$/, /^tsconfig[^/]*\.json$/, /^angular\.json$/, /^tailwind\.config\.js$/]),
});

/** NOT SHIPPED — the explicit allowlist, each entry with why it ships nothing. */
export const NOT_SHIPPED = Object.freeze([
  // angular.json copies no assets, tsconfig.app.json compiles only src/main.ts, Tailwind
  // scans only src/**/*.{html,ts}, and there is no public/: no .md reaches the payload.
  Object.freeze({ rule: '**/*.md', test: (p) => p.endsWith('.md') }),
  Object.freeze({ rule: 'docs/**', test: (p) => p.startsWith('docs/') }),
  // Not in the app's compile graph and no install lifecycle reads it; the deploy reads it
  // from the workflow revision, never the target. Its scanner/ manifest and lock are
  // certified inputs that CI installs, so they are always shipped (above).
  Object.freeze({ rule: 'dependency-audit/** (except dependency-audit/scanner/**)', test: (p) => p.startsWith('dependency-audit/') }),
  // Comment, issue and review automation: no id-token, referenced by neither ci.yml nor
  // deploy.yml, and nothing in them reaches the payload.
  Object.freeze({ rule: '.github/workflows/claude.yml', test: (p) => p === '.github/workflows/claude.yml' }),
  Object.freeze({ rule: '.github/workflows/claude-code-review.yml', test: (p) => p === '.github/workflows/claude-code-review.yml' }),
]);

const REGULAR_MODES = Object.freeze(['100644', '100755']);

/** Does a change to `path` change what Admin ships? Anything not explicitly allowlisted does. */
export function isShippedPath(path) {
  const p = String(path);
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (ALWAYS_SHIPPED.prefixes.some((x) => p.startsWith(x))) return true;
  if (ALWAYS_SHIPPED.exact.includes(p)) return true;
  if (ALWAYS_SHIPPED.basenames.some((re) => re.test(base))) return true;
  return !NOT_SHIPPED.some((r) => r.test(p));
}

const isRegular = (entry) => entry === undefined || (entry.type === 'blob' && REGULAR_MODES.includes(entry.mode));

/**
 * One commit's complete tree as the API states it: GET /git/commits/{sha} and
 * GET /git/trees/{tree}?recursive=1. Returns {entries: Map(path -> {mode, type, sha})}
 * or {problem}. A truncated listing is a problem, never a partial answer.
 */
export function readTree(sha, commit, tree) {
  if (!SHA_RE.test(String(sha))) return { problem: `${sha} is not a commit SHA` };
  if (!isObject(commit) || commit.sha !== sha || !SHA_RE.test(String(commit.tree?.sha))) return { problem: `the commit ${sha} could not be read` };
  if (!isObject(tree) || tree.sha !== commit.tree.sha) return { problem: `the tree of ${sha} could not be read` };
  if (tree.truncated !== false) return { problem: `the tree of ${sha} is truncated or does not say it is complete` };
  if (!Array.isArray(tree.tree)) return { problem: `the tree of ${sha} lists no entries` };
  const entries = new Map();
  for (const e of tree.tree) {
    if (!isObject(e) || typeof e.path !== 'string' || e.path === '' || e.path.startsWith('/')
      || !['blob', 'tree', 'commit'].includes(e.type) || !/^\d{6}$/.test(String(e.mode)) || !SHA_RE.test(String(e.sha))) {
      return { problem: `the tree of ${sha} carries a malformed entry` };
    }
    if (e.type === 'tree') continue; // a directory changes whenever its contents do; the leaves say what
    if (entries.has(e.path)) return { problem: `the tree of ${sha} lists ${e.path} twice` };
    entries.set(e.path, { mode: e.mode, type: e.type, sha: e.sha });
  }
  return { entries };
}

/** Every path whose entry differs between the two trees, judged on both sides. */
export function changedPaths(before, after) {
  const changes = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(path);
    const b = after.get(path);
    if (a && b && a.mode === b.mode && a.type === b.type && a.sha === b.sha) continue;
    let why = null;
    if (!isRegular(a) || !isRegular(b)) why = 'not a regular file';
    else if (isShippedPath(path)) why = 'shipped path';
    changes.push({ path, change: !a ? 'added' : !b ? 'deleted' : 'modified', shipped: why !== null, why });
  }
  return changes;
}

/**
 * Is the served commit's certified candidate retained with at least RETENTION_MIN_DAYS left?
 * The candidate is the one the existing rule selects: the latest attempt's of the ONE
 * successful push-to-main run for the served commit.
 */
export function servedRetention({ policy, served, ciWorkflow, run, artifacts, now, minDays = RETENTION_MIN_DAYS }) {
  if (!isObject(policy)) return { ok: false, detail: 'the release policy is unreadable' };
  if (!Number.isFinite(now)) return { ok: false, detail: 'the clock is unreadable' };
  if (!isObject(run)) return { ok: false, detail: `no single successful push-to-main CI run could be read for ${served}` };
  const sel = selectCertification({ policy, target: served, ciWorkflow, run, artifacts });
  if (!sel.selection) return { ok: false, detail: sel.problems.map((p) => `${p.code}: ${p.detail}`).join('; ') || 'no candidate could be selected' };
  const { name, expiresAt } = sel.selection.artifact;
  const expires = typeof expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(expiresAt) ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expires)) return { ok: false, artifact: name, detail: `${name} states no readable expiry` };
  const daysLeft = Math.floor(((expires - now) / DAY_MS) * 10) / 10;
  if (expires - now < minDays * DAY_MS) {
    return { ok: false, artifact: name, expiresAt, daysLeft, detail: `${name} expires ${expiresAt} (${daysLeft} days left; at least ${minDays} required)` };
  }
  return { ok: true, artifact: name, expiresAt, daysLeft, detail: `${name} is retained until ${expiresAt} (${daysLeft} days left)` };
}

/**
 * The decision. `skip` is true ONLY for code `no_shipped_change`; every other code deploys,
 * exactly as an automatic forward move did before this check existed.
 */
export function decideShippedChange({ served, target, servedCommit, servedTree, targetCommit, targetTree, policy, ciWorkflow, run, artifacts, now }) {
  const result = (skip, code, reason, extra = {}) => ({ schema: SHIPPED_CHANGE_SCHEMA, served, target, skip, code, reason, ...extra });
  const deploying = (why) => `${why}; deploying`;
  const before = readTree(served, servedCommit, servedTree);
  const after = readTree(target, targetCommit, targetTree);
  const problem = before.problem ?? after.problem;
  if (problem) return result(false, 'tree_unreadable', deploying(`the shipped-change check could not compare the trees (${problem})`));

  const changed = changedPaths(before.entries, after.entries);
  const shipped = changed.filter((c) => c.shipped);
  if (shipped.length) {
    const names = shipped.slice(0, 5).map((c) => c.path).join(', ');
    return result(false, 'shipped_change', deploying(`${shipped.length} shipped path${shipped.length === 1 ? '' : 's'} changed since ${served} (${names}${shipped.length > 5 ? ', …' : ''})`), { changed });
  }

  const retention = servedRetention({ policy, served, ciWorkflow, run, artifacts, now });
  if (!retention.ok) {
    return result(false, 'retention_insufficient', deploying(`no shipped change since ${served}, but its CI candidate cannot stay the rollback target: ${retention.detail}`), { changed, retention });
  }
  return result(true, 'no_shipped_change', `No shipped change since ${served}; not deployed`, { changed, retention });
}
