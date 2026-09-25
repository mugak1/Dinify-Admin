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

/** npm's severity vocabulary, least severe first (Arborist's vuln.js, npm-audit-report's exit-code.js). */
const SEVERITY_ORDER = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);
const rankOf = (severity) => SEVERITY_ORDER.indexOf(severity);
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const shapeOf = (value) => {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'string') return `the string ${JSON.stringify(value.slice(0, 60))}`;
  return typeof value === 'object' ? 'an object' : `the ${typeof value} ${String(value)}`;
};
const listOf = (names) => (names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', '));

/**
 * Read one `npm audit --json` answer for one graph. Returns {problems, findings}.
 *
 * The exit status is CROSS-CHECKED against the body rather than trusted alone: npm uses 1
 * both for "vulnerabilities found" and for "the audit failed", so a status is only
 * accepted when the body agrees with it.
 *
 * WHAT THE PINNED SCANNER WRITES — read from npm 11.19.1 and the @npmcli/arborist 9.9.1 and
 * @npmcli/metavuln-calculator 9.0.3 it bundles, as dependency-audit/scanner installs them:
 *   - `vulnerabilities` is an OBJECT keyed by package name. Each entry names itself, states
 *     a severity, lists the installed `nodes` (lock paths) it covers, and says why in `via`.
 *   - A `via` member is either an ADVISORY OBJECT — that package's own advisory, whose
 *     `name` and `dependency` are the entry's own name — or a STRING: a metavulnerability.
 *     The package is vulnerable only because the versions it depends on of the NAMED
 *     package are. Arborist links every such name to the entry it names before it writes
 *     anything, so a name the report does not list cannot have come from it.
 *   - A metavulnerability inherits the severity of the advisory it was derived from, so an
 *     entry is never more severe than the advisories it can be traced to.
 *   - `metadata.vulnerabilities` counts ENTRIES by severity, and its `total` is the number
 *     of entries. npm exits 1 exactly when a counter at or above `low` is non-zero — the
 *     default audit level, which scannerArgs does not change.
 *
 * THE RULE: every vulnerability the report declares is accounted for by advisory evidence
 * it carries, or the answer is incomplete. Being unable to interpret a reported
 * vulnerability is not evidence that there is none. A report that parsed, with the right
 * status and every advisory object read, could still say "high, via a package I do not
 * list", or "high, via each other" — and return no finding at all, which the policy would
 * then have called clean.
 *
 * A string cause produces no finding of its own, and that is deliberate. The advisory it
 * is traced to is already a finding on the nodes of the package that carries it, and one
 * advisory is not counted again for every package that depends on it. Findings are
 * therefore not one per vulnerable package: a package can carry several advisories and be
 * installed at several paths, and a package listed only through its dependencies carries
 * none. What the string causes ARE checked for is that they are grounded:
 *   - every name resolves to an entry in the same report;
 *   - every entry reaches, through its causes, an advisory the report carries. Evidence
 *     is propagated from each advisory to everything traced to it, without recursion, so
 *     a legitimate cycle with an advisory in it is accepted, and a cycle without one is
 *     refused rather than followed forever;
 *   - no entry is more severe than the advisories it is traced to;
 *   - an entry installed on a RUNTIME path is traced to at least one runtime finding. A
 *     runtime package's exposure must not quietly become tooling exposure because the
 *     only copies the report attributes are build-time ones.
 */
export function readReport({ graph, run, inv }) {
  const problems = [];
  const findings = [];
  const note = (code, detail) => problems.push({ code, detail: `${graph}: ${detail}` });
  const fail = (code, detail) => { note(code, detail); return { problems, findings }; };

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
  // Every container below is dereferenced, so each is checked for the shape npm writes
  // first. A list is not the package-name map even when it is empty: `[]` passes a
  // `typeof === 'object'` test, lists nothing, and read as "no vulnerabilities".
  if (!isMapping(vulns)) return fail('scanner_shape', `vulnerabilities is ${shapeOf(vulns)}, not the package-name map npm writes — a list that cannot be read is not an empty one`);
  if (!isMapping(meta) || !isMapping(meta.dependencies) || !isMapping(meta.vulnerabilities)) {
    return fail('scanner_shape', 'the report lacks the dependency and vulnerability counters npm writes in its metadata');
  }
  const total = meta.dependencies.total;
  if (!Number.isInteger(total) || total <= 0) return fail('coverage_empty', `the scanner counted ${total} dependencies — an empty inventory is refused, not passed`);
  if (total !== inv.packages.length) return fail('coverage_mismatch', `the scanner counted ${total} dependencies, the lock graph has ${inv.packages.length}`);
  const counted = meta.vulnerabilities;
  for (const key of [...SEVERITY_ORDER, 'total']) {
    if (!isCount(counted[key])) return fail('scanner_shape', `metadata.vulnerabilities.${key} is ${shapeOf(counted[key])}, not a count`);
  }
  const names = Object.keys(vulns);
  if (counted.total !== names.length) return fail('scanner_inconsistent', `metadata counts ${counted.total} vulnerable packages, the body lists ${names.length}`);
  const bySeverity = SEVERITY_ORDER.reduce((sum, severity) => sum + counted[severity], 0);
  if (bySeverity !== counted.total) return fail('scanner_inconsistent', `metadata counts ${counted.total} vulnerable packages, but ${bySeverity} by severity`);
  if (run.status === 1 && names.length === 0) return fail('scanner_status', 'the scanner exited 1 with no vulnerabilities and no error — an unexplained failure');
  // npm-audit-report's own rule at the default level. It is exact, so it is not replaced
  // by "any listed vulnerability means 1": an info-only report really does exit 0, and a
  // status that disagrees with these counters says the counters are not npm's.
  const expected = SEVERITY_ORDER.slice(1).some((severity) => counted[severity] > 0) ? 1 : 0;
  if (run.status !== expected) {
    const counts = SEVERITY_ORDER.filter((s) => counted[s] > 0).map((s) => `${counted[s]} ${s}`).join(', ') || 'nothing';
    return fail('scanner_inconsistent', `the scanner exited ${run.status}, but npm exits ${expected} for a report that counts ${counts}`);
  }

  const byPath = new Map(inv.packages.map((p) => [p.path.slice(graph.length + 1), p]));
  const listed = new Map();
  const declared = Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, 0]));
  let severitiesReadable = true;
  for (const name of names) {
    const entry = vulns[name];
    if (!isMapping(entry) || name === '') {
      severitiesReadable = false;
      note('scanner_shape', `vulnerability entry ${JSON.stringify(name)} is ${name === '' ? 'unnamed' : shapeOf(entry)}, not an entry npm writes`);
      continue;
    }
    if (entry.name !== undefined && entry.name !== name) note('scanner_inconsistent', `vulnerability entry ${name} names itself ${shapeOf(entry.name)}`);
    if (rankOf(entry.severity) === -1) {
      severitiesReadable = false;
      note('scanner_shape', `${name} has severity ${shapeOf(entry.severity)}, which is not one npm reports`);
    } else {
      declared[entry.severity] += 1;
    }
    if (!Array.isArray(entry.via) || entry.via.length === 0 || !Array.isArray(entry.nodes) || entry.nodes.length === 0) {
      note('scanner_shape', `vulnerability entry ${name} is malformed`);
      continue;
    }
    // What this entry carries itself, and what it is vulnerable through.
    const item = { severity: entry.severity, causes: [], own: { evidence: false, rank: -1, runtime: false }, onRuntimePath: false };
    listed.set(name, item);
    for (const node of entry.nodes) {
      if (typeof node !== 'string') { note('scanner_shape', `${name} lists ${shapeOf(node)} among its nodes, not an installed path`); continue; }
      if (!byPath.has(node)) note('coverage_unknown_node', `advisory node ${node} is not in the audited inventory`);
      else if (byPath.get(node).scope === 'runtime') item.onRuntimePath = true;
    }
    const advisories = [];
    for (const member of entry.via) {
      if (typeof member === 'string' && member !== '') item.causes.push(member);
      else if (isMapping(member)) advisories.push(member);
      // Filtering an unreadable member out would leave the rest looking complete.
      else note('scanner_shape', `${name} is vulnerable via ${shapeOf(member)}, which is neither an advisory nor the name of another vulnerable package`);
    }
    for (const via of advisories) {
      const ghsa = GHSA.exec(String(via.url ?? ''));
      if (via.source !== undefined && !Number.isInteger(via.source) && !(typeof via.source === 'string' && via.source !== '')) {
        note('scanner_shape', `an advisory on ${name} has source ${shapeOf(via.source)}, not an advisory id`);
        continue;
      }
      // GitHub prints advisory ids as `GHSA-xxxx-xxxx-xxxx`: upper-case prefix, lower-case body.
      const advisory = ghsa ? `GHSA-${ghsa[1].slice(5).toLowerCase()}` : (via.source !== undefined ? `npm:${via.source}` : null);
      if (!advisory) { note('scanner_shape', `an advisory on ${name} has no identifier`); continue; }
      // npm lists a package's own advisories under that package. An advisory naming
      // another package here could not be attributed: the nodes are this entry's.
      const foreign = ['name', 'dependency'].find((field) => via[field] !== undefined && via[field] !== name);
      if (foreign) { note('scanner_inconsistent', `an advisory whose ${foreign} is ${shapeOf(via[foreign])} is listed under ${name} — its findings could not be attributed to the right package`); continue; }
      const aliases = ghsa && via.source !== undefined ? [`npm:${via.source}`] : [];
      const nodes = entry.nodes.filter((n) => byPath.has(n));
      const matched = nodes.filter((n) => satisfies(byPath.get(n).version, via.range) === true);
      const attributed = matched.length ? matched : nodes;
      const severity = typeof via.severity === 'string' ? via.severity.toLowerCase() : 'unknown';
      for (const node of attributed) {
        const pkg = byPath.get(node);
        findings.push({
          advisory,
          aliases,
          package: name,
          version: pkg.version,
          path: pkg.path,
          scope: pkg.scope,
          severity,
          title: typeof via.title === 'string' ? via.title : '',
          url: typeof via.url === 'string' ? via.url : '',
        });
        if (pkg.scope === 'runtime') item.own.runtime = true;
      }
      if (attributed.length) {
        item.own.evidence = true;
        item.own.rank = Math.max(item.own.rank, rankOf(severity));
      }
    }
  }
  if (severitiesReadable) {
    for (const severity of SEVERITY_ORDER) {
      if (declared[severity] !== counted[severity]) note('scanner_inconsistent', `metadata counts ${counted[severity]} ${severity} vulnerable package(s), the body lists ${declared[severity]}`);
    }
  }

  // Every cause is a package the report lists.
  for (const [name, item] of listed) {
    for (const cause of item.causes) {
      if (!Object.hasOwn(vulns, cause)) {
        note('scanner_dangling_cause', `${name} is listed as vulnerable via ${cause}, which the report does not list — a cause that cannot be traced is not evidence of no vulnerability`);
      }
    }
  }

  // What each entry is traced to: its own advisories and, through every cause, theirs.
  // A worklist over the reverse edges rather than a recursive walk. Each value only grows
  // (evidence and runtime from false to true, rank upward) and has a ceiling, so an entry
  // is revisited at most a handful of times and the loop ends on any graph, cycles
  // included, with no stack to exhaust.
  const traced = new Map([...listed].map(([name, item]) => [name, { ...item.own }]));
  const dependents = new Map();
  for (const [name, item] of listed) {
    for (const cause of item.causes) {
      if (!listed.has(cause)) continue;
      if (!dependents.has(cause)) dependents.set(cause, []);
      dependents.get(cause).push(name);
    }
  }
  const queue = [...listed.keys()];
  while (queue.length) {
    const cause = queue.pop();
    const from = traced.get(cause);
    for (const name of dependents.get(cause) ?? []) {
      const was = traced.get(name);
      const now = { evidence: was.evidence || from.evidence, rank: Math.max(was.rank, from.rank), runtime: was.runtime || from.runtime };
      if (now.evidence !== was.evidence || now.rank !== was.rank || now.runtime !== was.runtime) {
        traced.set(name, now);
        queue.push(name);
      }
    }
  }

  let loops = null;
  for (const [name, item] of listed) {
    const reach = traced.get(name);
    if (!reach.evidence) {
      loops ??= cyclicComponents(listed);
      const why = item.causes.length === 0 ? 'it carries no advisory the report can attribute and names no cause'
        : loops.has(name) ? `its causes loop back to it (${loops.get(name)}) without reaching an advisory`
          : `none of its causes (${listOf([...item.causes].sort())}) leads to an advisory the report carries`;
      note('scanner_ungrounded', `${name} is listed as ${item.severity} but ${why} — a declared vulnerability the report does not account for is not the absence of one`);
      continue;
    }
    const declaredRank = rankOf(item.severity);
    if (declaredRank !== -1 && declaredRank > reach.rank) {
      note('scanner_unaccounted', `${name} is listed as ${item.severity}, but the most severe advisory it is traced to is ${SEVERITY_ORDER[reach.rank] ?? 'of no severity npm reports'}`);
    }
    if (declaredRank !== -1 && declaredRank < item.own.rank) {
      note('scanner_inconsistent', `${name} is listed as ${item.severity} but carries a ${SEVERITY_ORDER[item.own.rank]} advisory of its own`);
    }
    if (item.onRuntimePath && !reach.runtime) {
      note('scanner_unattributed', `${name} is installed on a runtime path, but every advisory it is traced to is attributed only to tooling paths — the runtime exposure cannot be established from this report`);
    }
  }
  return { problems, findings };
}

/**
 * The entries that lie on a cycle of causes, each mapped to a description of its cycle.
 * Tarjan's strongly-connected-components algorithm, written iteratively: one pass over the
 * report however long a cycle is, and no recursion for a long one to exhaust.
 */
function cyclicComponents(listed) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cyclic = new Map();
  let next = 0;
  const open = (name, work) => {
    index.set(name, next); low.set(name, next); next += 1;
    stack.push(name); onStack.add(name);
    work.push([name, 0]);
  };
  for (const start of listed.keys()) {
    if (index.has(start)) continue;
    const work = [];
    open(start, work);
    while (work.length) {
      const frame = work[work.length - 1];
      const [name, at] = frame;
      const causes = listed.get(name).causes;
      if (at < causes.length) {
        frame[1] += 1;
        const cause = causes[at];
        if (!listed.has(cause)) continue;
        if (!index.has(cause)) open(cause, work);
        else if (onStack.has(cause)) low.set(name, Math.min(low.get(name), index.get(cause)));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(name)));
      }
      if (low.get(name) !== index.get(name)) continue;
      const members = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== name);
      if (members.length > 1 || causes.includes(name)) {
        const description = members.length > 1 ? `a cycle of ${members.length}: ${listOf(members.sort())}` : 'it names itself';
        for (const m of members) cyclic.set(m, description);
      }
    }
  }
  return cyclic;
}
