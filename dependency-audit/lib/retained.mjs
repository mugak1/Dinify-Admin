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

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
 */
export function collect({ graph, dir, inv, kind, scopeOf, npmCli, policy, runner, clock, evidenceDir, env, baseEnv = process.env }) {
  const problems = [...inv.problems];
  const before = kind === 'retained' ? replayState(dir) : inventory(dir, { graph, env, scopeOf }).digests;
  const { env: scanEnv } = scannerEnvironment(baseEnv);
  const startedAt = clock();
  const run = runner({ command: process.execPath, args: [npmCli, ...scannerArgs(policy.scanner.registry)], cwd: dir, env: scanEnv, timeoutMs: policy.scanner.timeoutSeconds * 1000 });
  const finishedAt = clock();
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
    },
  };
}
