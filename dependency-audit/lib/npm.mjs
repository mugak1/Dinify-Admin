/**
 * THE npm ADAPTER — what was inspected, how the scanner is invoked, and how its answer is
 * read. Everything here either produces evidence or refuses; nothing turns an absent or
 * unreadable answer into a clean one.
 *
 * WHAT `npm audit` INSPECTS. Measured, not assumed: @npmcli/arborist's `audit()` calls
 * `loadVirtual()` — the LOCKFILE graph — unless `package-lock=false`. So the scan covers
 * every locked package, including optional platform packages this machine never
 * installed. `inventory()` therefore does two things: it reads the lock graph the scanner
 * reads, and it walks node_modules to prove the tree the build ran against IS that graph
 * (same paths, same versions), with every locked-but-absent package explained by a
 * platform mismatch. A lockfile audit of a tree that was never installed would prove
 * nothing about what ran.
 *
 * WHY THE INVOCATION IS HARDENED. Also measured: with an inherited NODE_ENV=production,
 * `npm audit --json` reports ZERO vulnerabilities while `metadata.dependencies.total`
 * still counts the whole graph — the narrowing is invisible in the report. So the scanner
 * is run with every dependency type explicitly included, with npm_* and NODE_ENV removed
 * from its environment, and against the public registry named in the policy.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { satisfies } from './range.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const posix = (p) => p.split(sep).join('/');

/** The libc npm would evaluate a `libc` constraint against. */
export function currentLibc() {
  if (process.platform !== 'linux') return null;
  const header = process.report?.getReport?.().header ?? {};
  return header.glibcVersionRuntime ? 'glibc' : 'musl';
}

export function environmentFacts() {
  return { node: process.version, platform: process.platform, arch: process.arch, libc: currentLibc() };
}

function allowed(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  if (value === null) return true;
  if (list.includes(`!${value}`)) return false;
  const positive = list.filter((x) => !String(x).startsWith('!'));
  return positive.length === 0 || positive.includes(value);
}

/** Would npm refuse to install this lock entry on this machine? Mirrors npm-install-checks. */
export function platformExcludes(entry, env = environmentFacts()) {
  return !allowed(entry.os, env.platform) || !allowed(entry.cpu, env.arch)
    || (env.platform === 'linux' && !allowed(entry.libc, env.libc));
}

/** Would npm skip this OPTIONAL entry because this Node does not satisfy its engines? */
export function enginesExclude(entry, env = environmentFacts()) {
  const range = entry.engines && typeof entry.engines === 'object' ? entry.engines.node : undefined;
  if (typeof range !== 'string') return false;
  return satisfies(String(env.node).replace(/^v/, ''), range) === false;
}

/** Node's resolution, over lock paths: the nearest `node_modules/<name>` walking up from `from`. */
export function resolveEdge(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (!base) return null;
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

/**
 * Why each locked-but-absent OPTIONAL package is absent, the way npm decides it: it fails
 * this machine's platform or engines check, or everything that depends on it is itself
 * absent for such a reason (npm prunes a failed optional package's whole subtree).
 * Anything not explained here is a real discrepancy between the lock graph and the tree.
 */
export function explainAbsences(packages, installed, env = environmentFacts()) {
  const dependents = new Map();
  for (const [from, entry] of Object.entries(packages)) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(entry[field] ?? {})) {
        const to = resolveEdge(packages, from, name);
        if (to === null) continue;
        if (!dependents.has(to)) dependents.set(to, new Set());
        dependents.get(to).add(from);
      }
    }
  }
  const optional = (p) => p !== '' && (packages[p].optional || packages[p].devOptional) && !installed.has(p);
  const why = new Map();
  for (const p of Object.keys(packages)) {
    if (!optional(p)) continue;
    if (platformExcludes(packages[p], env)) why.set(p, 'platform');
    else if (enginesExclude(packages[p], env)) why.set(p, 'engines');
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const p of Object.keys(packages)) {
      if (!optional(p) || why.has(p)) continue;
      const from = [...(dependents.get(p) ?? [])];
      if (from.length && from.every((d) => why.has(d))) { why.set(p, 'optional-subtree'); changed = true; }
    }
  }
  return why;
}

/** Every package directory under node_modules, recursively: `node_modules/a/node_modules/b`. */
export function walkInstalled(root) {
  const out = new Map();
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (!stat.isDirectory()) continue;
      if (name.startsWith('@')) { visit(full); continue; }
      const manifest = join(full, 'package.json');
      if (existsSync(manifest)) {
        let version = null;
        try { version = readJson(manifest).version ?? null; } catch { version = null; }
        out.set(posix(relative(root, full)), version);
      }
      visit(join(full, 'node_modules'));
    }
  };
  visit(join(root, 'node_modules'));
  return out;
}

const sameSpecs = (a = {}, b = {}) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/**
 * The lock graph of `root`, reconciled against what is installed there.
 *
 * @returns {{ packages, problems, digests, counts }} — `problems` is a list of
 *   {code, detail}; any entry makes the inventory unusable as evidence.
 */
export function inventory(root, { graph, env = environmentFacts(), scopeOf = defaultScope } = {}) {
  const problems = [];
  const lockPath = join(root, 'package-lock.json');
  const manifestPath = join(root, 'package.json');
  if (!existsSync(lockPath)) return { packages: [], problems: [{ code: 'no_lockfile', detail: `${graph}: no package-lock.json` }], digests: {}, counts: {} };
  if (!existsSync(manifestPath)) return { packages: [], problems: [{ code: 'no_manifest', detail: `${graph}: no package.json` }], digests: {}, counts: {} };
  const lockBytes = readFileSync(lockPath);
  const manifestBytes = readFileSync(manifestPath);
  let lock; let manifest;
  try { lock = JSON.parse(lockBytes); manifest = JSON.parse(manifestBytes); } catch (error) {
    return { packages: [], problems: [{ code: 'unreadable_manifest', detail: `${graph}: ${error.message}` }], digests: {}, counts: {} };
  }
  if (![2, 3].includes(lock.lockfileVersion) || typeof lock.packages !== 'object' || !lock.packages['']) {
    problems.push({ code: 'lockfile_version', detail: `${graph}: lockfileVersion ${lock.lockfileVersion} has no packages map` });
    return { packages: [], problems, digests: {}, counts: {} };
  }
  const rootEntry = lock.packages[''];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    if (!sameSpecs(rootEntry[field], manifest[field])) {
      problems.push({ code: 'lock_manifest_mismatch', detail: `${graph}: package-lock.json ${field} does not match package.json` });
    }
  }

  const installed = walkInstalled(root);
  const absences = explainAbsences(lock.packages, installed, env);
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    if (!path.startsWith('node_modules/') && !entry.link) {
      problems.push({ code: 'unexpected_lock_entry', detail: `${graph}: ${path} is not under node_modules` });
      continue;
    }
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const record = {
      path: `${graph}:${path}`,
      name,
      version: entry.version ?? null,
      integrity: entry.integrity ?? null,
      scope: scopeOf(entry),
      flags: ['dev', 'optional', 'devOptional', 'peer', 'inBundle', 'link'].filter((f) => entry[f]),
      installed: installed.has(path),
      absence: null,
    };
    if (!record.version && !entry.link) problems.push({ code: 'unversioned_lock_entry', detail: `${graph}: ${path} has no version` });
    if (installed.has(path)) {
      if (installed.get(path) !== entry.version) {
        problems.push({ code: 'installed_version_mismatch', detail: `${graph}: ${path} is ${installed.get(path)} installed, ${entry.version} locked` });
      }
    } else if (absences.has(path)) {
      record.absence = absences.get(path);
    } else if (!entry.link) {
      problems.push({ code: 'not_installed', detail: `${graph}: ${path}@${entry.version} is locked but not installed` });
    }
    packages.push(record);
  }
  for (const path of installed.keys()) {
    if (!(path in lock.packages)) problems.push({ code: 'extraneous', detail: `${graph}: ${path} is installed but not locked` });
  }
  // Every declared dependency must be in the graph — the "missing expected package" check.
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!lock.packages[`node_modules/${name}`]) problems.push({ code: 'missing_declared', detail: `${graph}: ${name} is declared but not in the lock graph` });
    }
  }
  if (packages.length === 0) problems.push({ code: 'empty_inventory', detail: `${graph}: the lock graph has no packages` });

  const treeLines = [...installed.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, v]) => `${p}\0${v}`);
  return {
    packages,
    problems,
    digests: {
      lockfileSha256: sha256(lockBytes),
      manifestSha256: sha256(manifestBytes),
      installedTreeSha256: sha256(treeLines.join('\n')),
    },
    counts: {
      locked: packages.length,
      installed: installed.size,
      absentOptional: packages.filter((p) => p.absence !== null).length,
      runtime: packages.filter((p) => p.scope === 'runtime').length,
      tooling: packages.filter((p) => p.scope === 'tooling').length,
    },
  };
}

/**
 * dev-only → executable build/test TOOLING. Everything else — prod, optional, and
 * devOptional (a dev package that is ALSO an optional dependency of a non-dev one) — is
 * treated as RUNTIME, the stricter scope. A devDependency classification decides only
 * which rule applies; it is not evidence that the package never executes.
 */
export function defaultScope(entry) {
  return entry.dev === true ? 'tooling' : 'runtime';
}

/** All scanner packages are tooling, whatever their lock flags say. */
export const toolingScope = () => 'tooling';

/** Environment variables that can narrow or redirect `npm audit`. Removed, never inherited. */
export function scannerEnvironment(base = process.env) {
  const env = {};
  const removed = [];
  for (const [key, value] of Object.entries(base)) {
    if (/^npm_/i.test(key) || key === 'NODE_ENV' || key === 'NODE_OPTIONS') { removed.push(key); continue; }
    env[key] = value;
  }
  env.npm_config_update_notifier = 'false';
  env.npm_config_fund = 'false';
  return { env, removed: removed.sort() };
}

/** The exact argv. Every dependency type is INCLUDED explicitly; `include` beats `omit`. */
export function scannerArgs(registry) {
  return ['audit', '--json', '--include=prod', '--include=dev', '--include=optional', '--include=peer',
    '--package-lock=true', `--registry=${registry}`, '--no-fund', '--no-update-notifier'];
}

const GHSA = /\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})/i;

/**
 * Read one `npm audit --json` answer for one graph. Returns {problems, findings}.
 *
 * The exit status is CROSS-CHECKED against the body rather than trusted alone: npm uses 1
 * both for "vulnerabilities found" and for "the audit failed", so a status is only
 * accepted when the body agrees with it.
 */
export function readReport({ graph, run, inv }) {
  const problems = [];
  const findings = [];
  const fail = (code, detail) => { problems.push({ code, detail: `${graph}: ${detail}` }); return { problems, findings }; };

  if (run.error) return fail('scanner_error', `the scanner could not be run (${run.error})`);
  if (run.timedOut) return fail('scanner_timeout', 'the scanner did not finish within the policy timeout');
  if (run.signal) return fail('scanner_signal', `the scanner was killed by ${run.signal}`);
  if (run.status !== 0 && run.status !== 1) return fail('scanner_status', `the scanner exited ${run.status}`);
  const text = run.stdout ?? '';
  if (text.trim() === '') return fail('scanner_empty', 'the scanner produced no output — an empty report is not a clean one');
  let report;
  try { report = JSON.parse(text); } catch (error) { return fail('scanner_unparseable', `the scanner output is not JSON (${error.message})`); }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return fail('scanner_shape', 'the scanner output is not a report object');
  if (report.error) {
    // Measured: a network failure arrives as exit 1 with the cause in a TOP-LEVEL
    // `message` and an empty `error.summary`, so both are read.
    const e = report.error;
    const said = [e.code, e.summary, e.detail, report.message].filter((x) => typeof x === 'string' && x.trim() !== '');
    return fail('scanner_reported_error', `the scanner reported an error: ${said.join(' — ') || 'unspecified'}`);
  }
  if (report.auditReportVersion !== 2) return fail('scanner_format', `auditReportVersion ${report.auditReportVersion} is not the supported version 2`);
  const vulns = report.vulnerabilities;
  const meta = report.metadata;
  if (!vulns || typeof vulns !== 'object' || !meta || typeof meta.dependencies !== 'object' || typeof meta.vulnerabilities !== 'object') {
    return fail('scanner_shape', 'the report lacks vulnerabilities or metadata');
  }
  const total = meta.dependencies.total;
  if (!Number.isInteger(total) || total <= 0) return fail('coverage_empty', `the scanner counted ${total} dependencies — an empty inventory is refused, not passed`);
  if (total !== inv.packages.length) return fail('coverage_mismatch', `the scanner counted ${total} dependencies, the lock graph has ${inv.packages.length}`);
  const names = Object.keys(vulns);
  if (meta.vulnerabilities.total !== names.length) return fail('scanner_inconsistent', `metadata counts ${meta.vulnerabilities.total} vulnerable packages, the body lists ${names.length}`);
  if (run.status === 0 && names.length > 0) return fail('scanner_inconsistent', 'the scanner exited 0 but listed vulnerabilities');
  if (run.status === 1 && names.length === 0) return fail('scanner_status', 'the scanner exited 1 with no vulnerabilities and no error — an unexplained failure');

  const byPath = new Map(inv.packages.map((p) => [p.path.slice(graph.length + 1), p]));
  for (const name of names) {
    const entry = vulns[name];
    if (!entry || !Array.isArray(entry.via) || !Array.isArray(entry.nodes) || entry.nodes.length === 0) {
      problems.push({ code: 'scanner_shape', detail: `${graph}: vulnerability entry ${name} is malformed` });
      continue;
    }
    const advisories = entry.via.filter((v) => v && typeof v === 'object');
    const effects = entry.via.filter((v) => typeof v === 'string');
    if (advisories.length === 0 && effects.length === 0) {
      problems.push({ code: 'scanner_shape', detail: `${graph}: ${name} is listed with no advisory and no cause` });
      continue;
    }
    for (const node of entry.nodes) {
      if (!byPath.has(node)) problems.push({ code: 'coverage_unknown_node', detail: `${graph}: advisory node ${node} is not in the audited inventory` });
    }
    for (const via of advisories) {
      const ghsa = GHSA.exec(String(via.url ?? ''));
      // GitHub prints advisory ids as `GHSA-xxxx-xxxx-xxxx`: upper-case prefix, lower-case body.
      const advisory = ghsa ? `GHSA-${ghsa[1].slice(5).toLowerCase()}` : (via.source !== undefined ? `npm:${via.source}` : null);
      if (!advisory) { problems.push({ code: 'scanner_shape', detail: `${graph}: an advisory on ${name} has no identifier` }); continue; }
      const aliases = ghsa && via.source !== undefined ? [`npm:${via.source}`] : [];
      const nodes = entry.nodes.filter((n) => byPath.has(n));
      const matched = nodes.filter((n) => satisfies(byPath.get(n).version, via.range) === true);
      const attributed = matched.length ? matched : nodes;
      for (const node of attributed) {
        const pkg = byPath.get(node);
        findings.push({
          advisory,
          aliases,
          package: via.name ?? name,
          version: pkg.version,
          path: pkg.path,
          scope: pkg.scope,
          severity: typeof via.severity === 'string' ? via.severity.toLowerCase() : 'unknown',
          title: typeof via.title === 'string' ? via.title : '',
          url: typeof via.url === 'string' ? via.url : '',
        });
      }
    }
  }
  return { problems, findings };
}
