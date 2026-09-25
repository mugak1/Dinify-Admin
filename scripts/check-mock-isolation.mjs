#!/usr/bin/env node
/**
 * Standing gate (ADMIN-MOCK-00): development-only code — the mock transports, their
 * fixtures and the primitives gallery — must not reach a production build.
 *
 * ── WHY A CHECK AND NOT A CONVENTION ──────────────────────────────────────────────
 *
 * The mocks let `npm start` render the whole application with no backend running,
 * which is how the visual direction gets reviewed. That convenience is also a
 * liability: a mock authentication implementation shipped to the control plane is an
 * authentication bypass with a friendly name, and the synthetic restaurant portfolio
 * shipped beside the real one is a screen an operator could act on.
 *
 * The structural defence is `angular.json`'s production `fileReplacements`, which
 * swaps `src/app/dev/dev-tools.ts` for `dev-tools.prod.ts` — a module that imports
 * nothing from `src/app/dev`. This script CHECKS that, because a structural guarantee
 * nobody verifies is a guarantee until the day someone adds an import.
 *
 * ── THREE CHECKS, BECAUSE A MARKER ALONE IS NOT A PROOF ────────────────────────────
 *
 * 1. SOURCE BOUNDARY. The production module graph is walked from the build entries
 *    `angular.json` declares, with the production `fileReplacements` applied, using
 *    the TypeScript compiler's own parser and module resolver and the tsconfig the
 *    build uses. Every module it reaches under `src/app/dev/` — other than a declared
 *    replacement target — is a violation, and so is any `*.spec.*` source. This is
 *    the check that catches a production file importing `mock-restaurants.fixtures.ts`
 *    or `mock-http-error.ts` DIRECTLY: neither carries a marker, and a real optimized
 *    build ships their code with nothing in the bundle for a string search to find.
 *    Edges: static `import` / `export … from`, `import x = require()`, `require()` and
 *    dynamic `import()` (Angular's `loadComponent` / `loadChildren`). Type-only imports
 *    are erased by the compiler and are not edges. A specifier that cannot be resolved,
 *    a dynamic import whose argument is not a literal, and a worker constructor are
 *    reported as INCOMPLETE rather than guessed at.
 *
 * 2. BUILD-OUTPUT COVERAGE. The output directory is the one `angular.json`'s production
 *    configuration names, not a guessed `dist/`. It must hold an `index.html` that loads
 *    at least one JavaScript entry, every file that page references, and every chunk
 *    those scripts import — statically or lazily — or the scan is incomplete. Symbolic
 *    links are refused (Angular emits none, and following one could leave or loop the
 *    tree), and a directory or file that cannot be read is reported, never skipped.
 *
 * 3. MARKERS. The mock transports and the gallery export a distinctive literal used in
 *    a way a minifier cannot drop (`console.warn`, a rendered `data-` attribute). If
 *    one survives into the output, it shipped. Markers are the built-output half of the
 *    proof for the modules that carry one; check 1 is what covers the modules that do
 *    not, and `scripts/tests/mock-isolation.build.test.mjs` proves both halves against
 *    real optimized builds.
 *
 * A marker match is not a proof of authentication correctness, and this gate does not
 * replace the application's own tests. It proves one thing: development-only code is
 * not in the production module graph or the production output.
 *
 * Usage:
 *
 *     npm run build:prod && npm run check:mock-isolation
 *     node scripts/check-mock-isolation.mjs --self-test     # prove every check fires
 *
 * `npm run check:mock-isolation` runs the self-test FIRST and the real scan only if it
 * passes, so a detector that silently stopped detecting cannot report a clean tree.
 *
 * Exit status: 0 complete and clean · 1 development-only code reaches production ·
 * 2 INCOMPLETE — the scan did not cover what it claims, which is never clean ·
 * 3 the self-test failed, so no scan was trusted.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const EXIT = Object.freeze({ CLEAN: 0, VIOLATION: 1, INCOMPLETE: 2, SELF_TEST: 3 });

/** The development-only tree. Everything under it is forbidden in production except a
 *  declared `fileReplacements` target (today: `dev-tools.prod.ts`). */
export const DEV_DIR = 'src/app/dev';

/** Test sources must never become part of the production module graph. */
const TEST_SOURCE = /\.spec\.[cm]?[jt]sx?$/;

/**
 * Must match the exported constants in `src/app/dev/`. Spelled here rather than
 * imported: this script runs against BUILT output, and an import would also mean the
 * checker and the checked share a single point of failure. The self-test verifies each
 * literal is still what its source file exports, so a renamed marker fails loudly
 * instead of silently turning its half of the proof off.
 */
export const FORBIDDEN_MARKERS = [
  { marker: 'DINIFY_ADMIN_MOCK_AUTH_PRESENT', source: 'src/app/dev/mock-admin-auth.ts' },
  { marker: 'DINIFY_ADMIN_GALLERY_PRESENT', source: 'src/app/dev/gallery.page.ts' },
  {
    marker: 'DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT',
    source: 'src/app/dev/mock-restaurant-api.ts',
  },
];

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.html', '.css'];
const JS_EXTENSIONS = ['.js', '.mjs'];

/** Build options this gate does not model. Present and truthy, they make it incomplete
 *  rather than silently unexamined. */
const UNMODELLED_BUILD_OPTIONS = ['server', 'ssr', 'prerender', 'appShell', 'webWorkerTsConfig', 'main'];

const toPosix = (p) => p.split(sep).join('/');
const rel = (root, p) => toPosix(relative(root, p)) || '.';
const errorText = (error) => (error && error.code ? error.code : String(error?.message ?? error));

/** Return `[{marker, source}]` for any marker present in `content`. */
export function findMarkersInContent(content) {
  return FORBIDDEN_MARKERS.filter(({ marker }) => content.includes(marker));
}

// ─────────────────────────────────────────────────────────────────────────────────
// The build contract: which entries, which replacements, which output directory.
// ─────────────────────────────────────────────────────────────────────────────────

/** A polyfills/scripts entry is a local file when it is path-shaped or names a file in
 *  the workspace; otherwise it is a package specifier (`zone.js`) and external. */
const isLocalEntry = (root, spec, fileExists) => /^(\.{1,2}\/|\/|src\/)/.test(spec) || fileExists(resolve(root, spec));

const realFileExists = (p) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Read the production build contract from `angular.json`. Pure over `readText` so the
 * self-test can drive it; the real run passes the repository's file.
 * @returns {{ entries: string[], replacements: Map<string,string>, outputDir: string|null,
 *             tsConfig: string|null, incomplete: string[] }}
 */
export function readBuildContract(root, { readText = (p) => readFileSync(p, 'utf8'), fileExists = realFileExists } = {}) {
  const incomplete = [];
  const empty = { entries: [], replacements: new Map(), outputDir: null, tsConfig: null, incomplete };
  let workspace;
  try {
    workspace = JSON.parse(readText(join(root, 'angular.json')));
  } catch (error) {
    incomplete.push(`angular.json could not be read: ${errorText(error)}`);
    return empty;
  }
  const projects = Object.values(workspace?.projects ?? {});
  if (projects.length !== 1) {
    incomplete.push(`angular.json declares ${projects.length} project(s); this gate models exactly one`);
    return empty;
  }
  const build = projects[0]?.architect?.build;
  if (build?.builder !== '@angular/build:application') {
    incomplete.push(`the build target uses "${build?.builder}", which this gate does not model`);
    return empty;
  }
  const production = build.configurations?.production;
  if (!production) {
    incomplete.push('angular.json has no production build configuration');
    return empty;
  }
  // Angular merges a configuration over the target's options, key by key.
  const merged = { ...build.options, ...production };
  for (const key of UNMODELLED_BUILD_OPTIONS) {
    if (merged[key]) incomplete.push(`the production build declares "${key}", which this gate does not model`);
  }

  const entries = [];
  if (typeof merged.browser !== 'string' || !merged.browser) {
    incomplete.push('the production build declares no "browser" entry');
  } else {
    entries.push(resolve(root, merged.browser));
  }
  for (const item of [...(merged.polyfills ?? []), ...(merged.scripts ?? [])]) {
    const spec = typeof item === 'string' ? item : item?.input;
    if (typeof spec !== 'string') {
      incomplete.push(`an entry in polyfills/scripts could not be read: ${JSON.stringify(item)}`);
    } else if (isLocalEntry(root, spec, fileExists)) {
      entries.push(resolve(root, spec));
    }
    // Otherwise a package specifier (`zone.js`): external by construction.
  }

  const replacements = new Map();
  for (const item of merged.fileReplacements ?? []) {
    const from = item?.replace ?? item?.src;
    const to = item?.with ?? item?.replaceWith;
    if (typeof from !== 'string' || typeof to !== 'string') {
      incomplete.push(`a fileReplacements entry could not be read: ${JSON.stringify(item)}`);
      continue;
    }
    replacements.set(resolve(root, from), resolve(root, to));
  }

  let outputDir = null;
  const out = merged.outputPath;
  if (typeof out === 'string' && out) {
    outputDir = resolve(root, out, 'browser');
  } else if (out && typeof out === 'object' && typeof out.base === 'string') {
    outputDir = resolve(root, out.base, typeof out.browser === 'string' ? out.browser : 'browser');
  } else {
    incomplete.push('the production build declares no readable outputPath');
  }

  const tsConfig = typeof merged.tsConfig === 'string' ? resolve(root, merged.tsConfig) : null;
  if (!tsConfig) incomplete.push('the production build declares no tsConfig');

  return { entries, replacements, outputDir, tsConfig, incomplete };
}

/** Compiler options from the tsconfig the build uses, or an incomplete reason. */
export function readCompilerOptions(tsConfigPath) {
  const read = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  if (read.error) {
    return { options: null, incomplete: [`${tsConfigPath} could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, ' ')}`] };
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsConfigPath));
  // A tsconfig whose `files` list does not exist is an error the build would also hit;
  // anything else (e.g. an empty `include` match) does not affect module resolution.
  const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error && d.code !== 18003);
  if (fatal.length) {
    return { options: null, incomplete: fatal.map((d) => `tsconfig: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`) };
  }
  return { options: parsed.options, incomplete: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Check 1 — the source boundary.
// ─────────────────────────────────────────────────────────────────────────────────

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** `import type …` is erased by the compiler. (`phaseModifier` replaced `isTypeOnly` in
 *  TypeScript 5.9; both are read so neither spelling of the API silently breaks this.) */
const isTypeOnlyClause = (clause) =>
  Boolean(clause) && (clause.phaseModifier === ts.SyntaxKind.TypeKeyword || clause.isTypeOnly === true);

/** The module references a source file makes, as `{spec, line}` or `{unmodelled, line}`. */
export function moduleReferences(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
  const found = [];
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyClause(node.importClause)) found.push({ spec: literal(node.moduleSpecifier), line: line(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly) found.push({ spec: literal(node.moduleSpecifier), line: line(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.isTypeOnly) found.push({ spec: literal(node.moduleReference.expression), line: line(node) });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      if (isImport || isRequire) {
        const spec = literal(node.arguments[0]);
        found.push(spec === null
          ? { unmodelled: `a ${isImport ? 'dynamic import()' : 'require()'} whose argument is not a string literal`, line: line(node) }
          : { spec, line: line(node) });
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === 'Worker' || node.expression.text === 'SharedWorker')) {
      found.push({ unmodelled: `a ${node.expression.text} entry, which this gate does not model`, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** A real-filesystem module-resolution host, with an optional in-memory overlay. */
export function fileSystemHost(root, overlay = new Map()) {
  return {
    fileExists: (p) => overlay.has(p) || ts.sys.fileExists(p),
    readFile: (p) => (overlay.has(p) ? overlay.get(p) : ts.sys.readFile(p)),
    directoryExists: (p) => ts.sys.directoryExists(p),
    realpath: ts.sys.realpath,
    getCurrentDirectory: () => root,
    readSource: (p) => (overlay.has(p) ? overlay.get(p) : readFileSync(p, 'utf8')),
  };
}

/** Where a reached module sits: 'dev', 'test', or null for an ordinary source. */
function forbiddenKind(root, file, allowedTargets) {
  const path = rel(root, file);
  if (path.startsWith(`${DEV_DIR}/`) && !allowedTargets.has(file)) return 'dev';
  if (TEST_SOURCE.test(path)) return 'test';
  return null;
}

/**
 * Walk the production module graph and classify what it reaches.
 * @returns {{ walked: number, applied: Array<[string,string]>, violations: object[],
 *             incomplete: string[] }}
 */
export function analyseSourceBoundary({ root, entries, replacements, compilerOptions, host }) {
  const incomplete = [];
  const violations = [];
  const parent = new Map();
  const applied = new Map();
  const queue = [];
  const allowedTargets = new Set(replacements.values());

  for (const entry of entries) {
    if (!parent.has(entry)) {
      parent.set(entry, null);
      queue.push(entry);
    }
  }
  if (!queue.length) incomplete.push('source boundary: the build declares no entry to walk from');

  while (queue.length) {
    const file = queue.shift();
    // What the build compiles for this path: a replacement's content keeps the original
    // path (the esbuild metafile names the replaced file), and imports inside it resolve
    // from the original location.
    const compiled = replacements.get(file) ?? file;
    if (compiled !== file) applied.set(file, compiled);
    let text;
    try {
      text = host.readSource(compiled);
    } catch (error) {
      incomplete.push(`source boundary: ${rel(root, compiled)} could not be read (${errorText(error)})`);
      continue;
    }
    for (const ref of moduleReferences(compiled, text)) {
      if (ref.unmodelled) {
        incomplete.push(`source boundary: ${rel(root, compiled)}:${ref.line} uses ${ref.unmodelled}`);
        continue;
      }
      if (ref.spec === null) {
        incomplete.push(`source boundary: ${rel(root, compiled)}:${ref.line} has a module reference that is not a string literal`);
        continue;
      }
      const resolved = ts.resolveModuleName(ref.spec, file, compilerOptions, host).resolvedModule;
      if (!resolved) {
        incomplete.push(`source boundary: "${ref.spec}" (${rel(root, compiled)}:${ref.line}) could not be resolved`);
        continue;
      }
      if (resolved.isExternalLibraryImport || resolved.resolvedFileName.endsWith('.d.ts')) continue;
      const target = resolve(resolved.resolvedFileName);
      const path = rel(root, target);
      if (path.startsWith('../')) {
        incomplete.push(`source boundary: "${ref.spec}" (${rel(root, compiled)}:${ref.line}) resolves outside the workspace`);
        continue;
      }
      if (!parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }

  const chainOf = (file) => {
    const chain = [];
    for (let at = file; at !== null && at !== undefined; at = parent.get(at)) chain.unshift(rel(root, at));
    return chain;
  };
  for (const file of parent.keys()) {
    const compiled = replacements.get(file) ?? file;
    const kind = forbiddenKind(root, compiled, allowedTargets);
    if (kind) violations.push({ file: rel(root, compiled), kind, chain: chainOf(file) });
  }
  return {
    walked: parent.size,
    // Each reached path as the build names it (the esbuild metafile keeps a replaced
    // file's ORIGINAL path) beside the source actually compiled for it.
    modules: [...parent.keys()].map((file) => ({ path: rel(root, file), compiled: rel(root, replacements.get(file) ?? file) })),
    applied: [...applied].map(([from, to]) => [rel(root, from), rel(root, to)]),
    violations,
    incomplete,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Check 2 and 3 — the build output: coverage, then markers.
// ─────────────────────────────────────────────────────────────────────────────────

const realOutputFs = {
  lstat: (p) => lstatSync(p),
  readdir: (p) => readdirSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
};

const HTML_REFERENCE = /<(script|link)\b[^>]*>/gi;
const ATTRIBUTE = (name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
const JS_REFERENCE = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"'\s]+?\.m?js)["']/g;

const isLocalReference = (value) => value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//');
const stripQuery = (value) => value.split(/[?#]/)[0];

/**
 * Inspect a build output directory. Pure over `fsx`, so reader failures can be
 * simulated deterministically (permission bits mean nothing to a process running as
 * root, which is exactly how CI runners and containers often run).
 */
export function scanBuildOutput(outputDir, { fsx = realOutputFs, root = REPO_ROOT } = {}) {
  const incomplete = [];
  const files = new Map(); // relative path -> content (scanned extensions only)
  const others = new Set(); // relative paths of files not scanned for markers
  const where = rel(root, outputDir);
  const result = (extra) => ({ where, files, others, incomplete, markers: [], ...extra });

  let top;
  try {
    top = fsx.lstat(outputDir);
  } catch (error) {
    incomplete.push(error?.code === 'ENOENT'
      ? `build output: ${where}/ does not exist — run \`npm run build:prod\` first; a scan with nothing to scan is not a pass`
      : `build output: ${where}/ could not be read (${errorText(error)})`);
    return result({ entries: [], reachable: new Set() });
  }
  if (top.isSymbolicLink() || !top.isDirectory()) {
    incomplete.push(`build output: ${where} is not a directory`);
    return result({ entries: [], reachable: new Set() });
  }

  const stack = [outputDir];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = [...fsx.readdir(dir)].sort();
    } catch (error) {
      incomplete.push(`build output: directory ${rel(root, dir)}/ could not be listed (${errorText(error)})`);
      continue;
    }
    for (const name of names) {
      const full = join(dir, name);
      const key = toPosix(relative(outputDir, full));
      let stat;
      try {
        stat = fsx.lstat(full);
      } catch (error) {
        incomplete.push(`build output: ${rel(root, full)} could not be inspected (${errorText(error)})`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        incomplete.push(`build output: ${rel(root, full)} is a symbolic link — refused; the production build emits none`);
      } else if (stat.isDirectory()) {
        stack.push(full);
      } else if (!stat.isFile()) {
        incomplete.push(`build output: ${rel(root, full)} is not a regular file`);
      } else if (SCANNED_EXTENSIONS.some((extension) => name.endsWith(extension))) {
        try {
          files.set(key, fsx.readFile(full));
        } catch (error) {
          incomplete.push(`build output: ${rel(root, full)} could not be read (${errorText(error)})`);
          others.add(key);
        }
      } else {
        others.add(key);
      }
    }
  }

  // Tie the inspected files to the application the output actually serves.
  const exists = (key) => files.has(key) || others.has(key);
  const entries = [];
  const index = files.get('index.html');
  if (index === undefined) {
    incomplete.push(`build output: ${where}/index.html is missing — this is not the production application layout`);
  } else {
    for (const tag of index.match(HTML_REFERENCE) ?? []) {
      const isScript = /^<script/i.test(tag);
      const value = tag.match(ATTRIBUTE(isScript ? 'src' : 'href'))?.[1];
      if (!isLocalReference(value)) continue;
      if (!isScript && !/\brel\s*=\s*["'](?:modulepreload|stylesheet|preload)["']/i.test(tag)) continue;
      const key = toPosix(join('.', stripQuery(value)));
      if (!exists(key)) {
        incomplete.push(`build output: index.html references ${key}, which ${where}/ does not contain`);
      } else if (isScript && JS_EXTENSIONS.some((extension) => key.endsWith(extension))) {
        entries.push(key);
      }
    }
    if (!entries.length) incomplete.push('build output: index.html loads no JavaScript application entry');
  }

  // Every chunk the entries import — statically or lazily — must be present and read.
  const reachable = new Set(entries);
  const pending = [...entries];
  while (pending.length) {
    const key = pending.pop();
    const content = files.get(key);
    if (content === undefined) continue;
    for (const match of content.matchAll(JS_REFERENCE)) {
      const target = toPosix(join(dirname(key), match[1]));
      if (reachable.has(target)) continue;
      if (!files.has(target)) {
        incomplete.push(`build output: ${key} imports ${target}, which ${where}/ does not contain or could not read`);
        continue;
      }
      reachable.add(target);
      pending.push(target);
    }
  }

  const markers = [];
  for (const [key, content] of files) {
    for (const hit of findMarkersInContent(content)) markers.push({ file: `${where}/${key}`, ...hit });
  }
  return { where, files, others, incomplete, markers, entries, reachable };
}

// ─────────────────────────────────────────────────────────────────────────────────
// The self-test: every check must fire on what it claims to catch.
// ─────────────────────────────────────────────────────────────────────────────────

/** An in-memory module-resolution host rooted at `root`. */
function memoryHost(root, sources) {
  const files = new Map(Object.entries(sources).map(([p, text]) => [join(root, p), text]));
  const dirs = new Set();
  for (const file of files.keys()) {
    for (let d = dirname(file); d.startsWith(root); d = dirname(d)) {
      dirs.add(d);
      if (d === root) break;
    }
  }
  return {
    fileExists: (p) => files.has(p),
    readFile: (p) => files.get(p),
    directoryExists: (p) => dirs.has(p),
    getCurrentDirectory: () => root,
    readSource: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(p);
    },
  };
}

/** An in-memory output filesystem; `fail` maps a relative path to an error code. */
function memoryOutputFs(root, tree, fail = {}) {
  const node = (p) => {
    const key = toPosix(relative(root, p));
    if (fail[key]) throw Object.assign(new Error(fail[key]), { code: fail[key] });
    if (key === '' || key === '.') return { dir: true };
    let at = tree;
    for (const part of key.split('/')) {
      if (at === undefined || typeof at === 'string' || at.__link) return undefined;
      at = at[part];
    }
    if (at === undefined) return undefined;
    return typeof at === 'string' ? { file: at } : at.__link ? { link: true } : { dir: at };
  };
  const stat = (n) => ({
    isFile: () => n.file !== undefined,
    isDirectory: () => Boolean(n.dir),
    isSymbolicLink: () => Boolean(n.link),
  });
  return {
    lstat: (p) => {
      const n = node(p);
      if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return stat(n);
    },
    readdir: (p) => {
      const key = toPosix(relative(root, p));
      if (fail[`${key || '.'}/`]) throw Object.assign(new Error(fail[`${key || '.'}/`]), { code: fail[`${key || '.'}/`] });
      const n = node(p);
      return Object.keys(n.dir === true ? tree : n.dir);
    },
    readFile: (p) => {
      const key = toPosix(relative(root, p));
      if (fail[`read:${key}`]) throw Object.assign(new Error(fail[`read:${key}`]), { code: fail[`read:${key}`] });
      return node(p).file;
    },
  };
}

const V_ROOT = resolve('/virtual-admin');
const V_REPLACEMENTS = new Map([[join(V_ROOT, 'src/app/dev/dev-tools.ts'), join(V_ROOT, 'src/app/dev/dev-tools.prod.ts')]]);
const V_OPTIONS = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ES2022,
  target: ts.ScriptTarget.ES2022,
  baseUrl: V_ROOT,
};
const V_SOURCES = {
  'src/main.ts': "import { appConfig } from './app/app.config';\nexport const boot = appConfig;\n",
  'src/app/app.config.ts': "import { DEV_PROVIDERS } from './dev/dev-tools';\nimport type { Rows } from './dev/fixtures';\nexport const appConfig = { providers: DEV_PROVIDERS as Rows[] };\n",
  'src/app/feature.ts': 'export const feature = 1;\n',
  'src/app/feature.spec.ts': 'export const spec = 1;\n',
  'src/app/dev/dev-tools.ts': "import { MockApi } from './mock-api';\nexport const DEV_PROVIDERS = [MockApi];\n",
  'src/app/dev/dev-tools.prod.ts': 'export const DEV_PROVIDERS = [];\n',
  'src/app/dev/mock-api.ts': 'export class MockApi {}\n',
  'src/app/dev/fixtures.ts': 'export type Rows = unknown;\nexport const ROWS = [1, 2, 3];\n',
  'src/app/dev/gallery.page.ts': 'export class GalleryPage {}\n',
};

function boundaryCase(edits, { replacements = V_REPLACEMENTS } = {}) {
  const sources = { ...V_SOURCES };
  for (const [file, text] of Object.entries(edits)) sources[file] = text;
  return analyseSourceBoundary({
    root: V_ROOT,
    entries: [join(V_ROOT, 'src/main.ts')],
    replacements,
    compilerOptions: V_OPTIONS,
    host: memoryHost(V_ROOT, sources),
  });
}

const O_ROOT = resolve('/virtual-dist');
const O_TREE = {
  'index.html': '<html><head><link rel="stylesheet" href="styles-A.css"><link rel="modulepreload" href="chunk-B.js"></head><body><script src="main-A.js" type="module"></script></body></html>',
  'main-A.js': 'import{a}from"./chunk-B.js";const r=()=>import("./chunk-C.js");a(r,"DINIFY_ADMIN and a mock word");',
  'chunk-B.js': 'export const a=(x)=>x;',
  'chunk-C.js': 'import"./nested/chunk-D.js";export const c=1;',
  nested: { 'chunk-D.js': 'export const d=1;' },
  'styles-A.css': 'body{color:red}',
  'prerendered-routes.json': '{"routes":{}}',
  media: { 'font.woff2': '\u0000binary' },
};

function outputCase(edit = (tree) => tree, fail = {}) {
  const tree = edit(structuredClone(O_TREE));
  return scanBuildOutput(O_ROOT, { fsx: memoryOutputFs(O_ROOT, tree, fail), root: dirname(O_ROOT) });
}

export function selfTest({ root = REPO_ROOT, log = console.log, error = console.error } = {}) {
  const failures = [];
  const expect = (label, condition) => {
    if (!condition) failures.push(label);
  };

  // ── markers: the matcher, and that each literal is still what its source emits ──
  const matcher = [
    ['a bundle carrying the mock marker', 'x="DINIFY_ADMIN_MOCK_AUTH_PRESENT"', 1],
    ['a bundle carrying the gallery marker', 'a.setAttribute("data-build-marker","DINIFY_ADMIN_GALLERY_PRESENT")', 1],
    ['a bundle carrying the restaurant-mock marker', 'console.warn("DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT")', 1],
    ['a bundle carrying all three', 'DINIFY_ADMIN_MOCK_AUTH_PRESENT DINIFY_ADMIN_GALLERY_PRESENT DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT', 3],
    ['an ordinary production bundle', 'const e="Invalid credentials.";export{e};', 0],
    ['a near miss', 'const DINIFY_ADMIN = 1;', 0],
  ];
  for (const [label, content, want] of matcher) expect(`marker matcher: ${label}`, findMarkersInContent(content).length === want);
  for (const { marker, source } of FORBIDDEN_MARKERS) {
    let text = '';
    try {
      text = readFileSync(join(root, source), 'utf8');
    } catch {
      // reported below
    }
    expect(`marker source: ${source} exports '${marker}'`, text.includes(`'${marker}'`));
  }

  // ── source boundary ─────────────────────────────────────────────────────────────
  const clean = boundaryCase({});
  expect('boundary: the replaced seam is clean', clean.violations.length === 0 && clean.incomplete.length === 0);
  expect('boundary: the replacement is applied', clean.applied.some(([, to]) => to === 'src/app/dev/dev-tools.prod.ts'));
  expect('boundary: a type-only import is not an edge', !clean.violations.some((v) => v.file.endsWith('fixtures.ts')));
  const dev = (result, file) => result.violations.some((v) => v.file === `src/app/dev/${file}` && v.kind === 'dev');
  const unreplaced = boundaryCase({}, { replacements: new Map() });
  expect('boundary: a removed replacement exposes the seam and the mock', dev(unreplaced, 'dev-tools.ts') && dev(unreplaced, 'mock-api.ts'));
  expect('boundary: a direct import of a marker-free fixture is refused',
    dev(boundaryCase({ 'src/app/feature.ts': "import { ROWS } from './dev/fixtures';\nexport const feature = ROWS.length;\n", 'src/main.ts': "import './app/feature';\n" }), 'fixtures.ts'));
  expect('boundary: a lazy route to the gallery is refused',
    dev(boundaryCase({ 'src/main.ts': "export const routes = [{ loadComponent: () => import('./app/dev/gallery.page').then((m) => m.GalleryPage) }];\n" }), 'gallery.page.ts'));
  expect('boundary: a re-export is refused', dev(boundaryCase({ 'src/main.ts': "export * from './app/dev/mock-api';\n" }), 'mock-api.ts'));
  expect('boundary: a baseUrl-style import is refused', dev(boundaryCase({ 'src/main.ts': "import { MockApi } from 'src/app/dev/mock-api';\nexport const x = MockApi;\n" }), 'mock-api.ts'));
  expect('boundary: a spec source in the graph is refused',
    boundaryCase({ 'src/main.ts': "import './app/feature.spec';\n" }).violations.some((v) => v.kind === 'test'));
  expect('boundary: an unresolvable import is incomplete, not clean', boundaryCase({ 'src/main.ts': "import './app/missing';\n" }).incomplete.length === 1);
  expect('boundary: a non-literal dynamic import is incomplete', boundaryCase({ 'src/main.ts': 'const n = "x";\nexport const l = () => import(n);\n' }).incomplete.length === 1);

  // ── build output ───────────────────────────────────────────────────────────────
  const ok = outputCase();
  expect('output: a complete layout is complete', ok.incomplete.length === 0);
  expect('output: lazy and nested chunks are reached', ok.reachable.has('chunk-C.js') && ok.reachable.has('nested/chunk-D.js'));
  expect('output: legitimate strings do not match', ok.markers.length === 0);
  const lazyHit = outputCase((t) => ({ ...t, nested: { 'chunk-D.js': 'console.warn("DINIFY_ADMIN_MOCK_AUTH_PRESENT")' } }));
  expect('output: a marker in a nested lazy chunk is found', lazyHit.markers.some((m) => m.file.endsWith('nested/chunk-D.js')));
  const gap = (label, result) => expect(`output: ${label} is incomplete`, result.incomplete.length > 0);
  gap('a missing output directory', scanBuildOutput(join(O_ROOT, 'absent'), { fsx: memoryOutputFs(O_ROOT, O_TREE), root: dirname(O_ROOT) }));
  gap('an empty output directory', outputCase(() => ({})));
  gap('an index.html that loads no JavaScript', outputCase((t) => ({ 'index.html': '<link rel="stylesheet" href="styles-A.css">', 'styles-A.css': t['styles-A.css'] })));
  gap('a directory holding only a stylesheet', outputCase((t) => ({ 'styles-A.css': t['styles-A.css'] })));
  gap('an entry script index.html names but the output lacks', outputCase((t) => { delete t['main-A.js']; return t; }));
  gap('a chunk an entry imports but the output lacks', outputCase((t) => { delete t['chunk-C.js']; return t; }));
  gap('an unreadable chunk', outputCase(undefined, { 'read:chunk-B.js': 'EACCES' }));
  gap('an unlistable directory', outputCase(undefined, { 'media/': 'EACCES' }));
  gap('a symbolic link', outputCase((t) => ({ ...t, loop: { __link: true } })));

  if (failures.length) {
    for (const label of failures) error(`  self-test FAIL: ${label}`);
    error(`\nMock-isolation gate self-test: ${failures.length} case(s) failed — the detector cannot be trusted, so no scan was run.`);
    return EXIT.SELF_TEST;
  }
  log('Mock-isolation gate self-test: OK — markers, source boundary and build-output coverage all fire.');
  return EXIT.CLEAN;
}

// ─────────────────────────────────────────────────────────────────────────────────
// The real scan.
// ─────────────────────────────────────────────────────────────────────────────────

export function runGate({ root = REPO_ROOT, log = console.log } = {}) {
  const contract = readBuildContract(root);
  const incomplete = [...contract.incomplete];
  let boundary = { walked: 0, modules: [], applied: [], violations: [], incomplete: [] };
  if (contract.entries.length && contract.tsConfig) {
    const { options, incomplete: tsIncomplete } = readCompilerOptions(contract.tsConfig);
    incomplete.push(...tsIncomplete);
    if (options) {
      boundary = analyseSourceBoundary({
        root, entries: contract.entries, replacements: contract.replacements, compilerOptions: options, host: fileSystemHost(root),
      });
    }
  }
  incomplete.push(...boundary.incomplete);
  const output = contract.outputDir
    ? scanBuildOutput(contract.outputDir, { root })
    : { where: '(unknown)', files: new Map(), others: new Set(), incomplete: [], markers: [], entries: [], reachable: new Set() };
  incomplete.push(...output.incomplete);

  const js = [...output.files.keys()].filter((key) => JS_EXTENSIONS.some((extension) => key.endsWith(extension))).length;
  log('Mock-isolation gate');
  log(`  source boundary : ${boundary.walked} production module(s) walked from ${contract.entries.map((e) => rel(root, e)).join(', ') || '(none)'}` +
    `; replacement(s) applied: ${boundary.applied.map(([from, to]) => `${from} -> ${to}`).join(', ') || 'none'}`);
  log(`  build output    : ${output.where}/ — ${output.files.size + output.others.size} file(s) inspected, ${output.files.size} scanned (${js} JavaScript); ` +
    `index.html loads ${output.entries.length} entry script(s); ${Math.max(output.reachable.size - output.entries.length, 0)} chunk(s) reached through module imports`);
  log(`  markers         : ${FORBIDDEN_MARKERS.length} checked, ${output.markers.length} present`);

  const violations = [
    ...boundary.violations.map((v) => `source: ${v.file} is ${v.kind === 'dev' ? 'development-only' : 'a test source'} and is in the production module graph (${v.chain.join(' -> ')})`),
    ...output.markers.map((m) => `output: ${m.file} carries ${m.marker} (from ${m.source})`),
  ];
  if (violations.length) {
    log('');
    log('Mock-isolation gate: FAIL — development-only code reaches production:');
    for (const line of violations) log(`  ${line}`);
    if (incomplete.length) {
      log('  …and the scan was also incomplete:');
      for (const line of incomplete) log(`  ${line}`);
    }
    log('');
    log('The production configuration file-replaces src/app/dev/dev-tools.ts. Something now reaches src/app/dev from a module the production build compiles.');
    return EXIT.VIOLATION;
  }
  if (incomplete.length) {
    log('');
    log('Mock-isolation gate: INCOMPLETE — the scan did not cover what it claims to, so this is NOT a clean result:');
    for (const line of incomplete) log(`  ${line}`);
    return EXIT.INCOMPLETE;
  }
  log('Mock-isolation gate: OK — complete scan; no development-only code in the production module graph or the build output.');
  return EXIT.CLEAN;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  return runGate();
}

// Run only as the entry point, so the exported checks can be imported by the tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
