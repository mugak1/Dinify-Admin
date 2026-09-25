/**
 * ADMIN-MOCK-00 — the mock-isolation gate proves it can find what it claims to find,
 * and its real consumers cannot turn a detector failure or an incomplete scan green.
 *
 * Fast: no Angular build here (see mock-isolation.build.test.mjs for the optimized
 * builds). Everything below drives the REAL scripts/check-mock-isolation.mjs — through
 * `npm run check:mock-isolation` in a disposable workspace where a test needs the
 * consumer, and through its exported checks where a failure has to be simulated.
 *
 * Labels: CONTRACT (a committed file says what it must), CONTROL (the ordinary case
 * passes), REGRESSION (a reproduced false-clean now fails), NEGATIVE CONTROL (the
 * mechanism a CONTRACT forbids really would hide a failure).
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  analyseSourceBoundary,
  EXIT,
  fileSystemHost,
  readBuildContract,
  readCompilerOptions,
  scanBuildOutput,
} from '../check-mock-isolation.mjs';
import { commandOf, loadWorkflow, runStep, simulateJob, statusSwallowers } from '../../dependency-audit/tests/workflow-harness.mjs';
import { makeWorkspace, NODE_DIR, NPM_CLI, ROOT, writeSyntheticDist } from './workspace.mjs';

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CI = loadWorkflow(join(ROOT, '.github/workflows/ci.yml'));
const DEPLOY = loadWorkflow(join(ROOT, '.github/workflows/deploy.yml'));
const VERIFY = readFileSync(join(ROOT, 'scripts/verify.sh'), 'utf8');
const VALIDATE = CI.jobs.validate.steps;
const GATE = 'npm run check:mock-isolation';
const GUARDS = 'npm run test:guards';
const GATE_SCRIPT = 'scripts/check-mock-isolation.mjs';

const indexOfRun = (steps, run) => steps.findIndex((step) => commandOf(step) === run);

// ─────────────────────────────────────────────────────────────────────────────────
describe('the required check runs the self-test before the real scan', () => {
  it('CONTRACT: the package script runs --self-test first and the scan only if it passes', () => {
    assert.equal(PKG.scripts['check:mock-isolation'],
      'node scripts/check-mock-isolation.mjs --self-test && node scripts/check-mock-isolation.mjs');
    assert.deepEqual(statusSwallowers(PKG.scripts['check:mock-isolation']), []);
  });

  it('CONTRACT: `validate` builds, then gates the build it just made, with nothing softening either step', () => {
    const build = indexOfRun(VALIDATE, 'npm run build:prod');
    assert.ok(build >= 0);
    assert.equal(indexOfRun(VALIDATE, GATE), build + 1, 'the gate scans the output the step before it produced');
    for (const run of [GATE, GUARDS, 'npm run build:prod']) {
      const step = VALIDATE[indexOfRun(VALIDATE, run)];
      assert.ok(step, run);
      assert.equal(step.if, undefined, run);
      assert.equal(step['continue-on-error'], undefined, run);
      assert.equal(step.shell, undefined, run);
      assert.deepEqual(statusSwallowers(commandOf(step)), [], run);
    }
    assert.ok(indexOfRun(VALIDATE, GUARDS) < indexOfRun(VALIDATE, 'npm run test:ci'), 'the qualification fails fast, before the long suite');
  });

  it('CONTRACT (static, not an executed deployment): the deploy builds, then runs the SAME package script on the dist/ it packages', () => {
    const prepare = DEPLOY.jobs.prepare.steps;
    const build = indexOfRun(prepare, 'npm run build:prod');
    const gate = indexOfRun(prepare, GATE);
    assert.ok(build >= 0 && gate === build + 1);
    assert.equal(prepare[gate].if, prepare[build].if, 'the gate runs whenever the build does');
    assert.equal(prepare[gate]['continue-on-error'], undefined);
    const stamp = prepare.findIndex((step) => /stamp release\.txt/.test(String(step.name)));
    assert.ok(stamp > gate, 'nothing is stamped or packaged before the gate passes');
  });

  it('CONTRACT: verify.sh mirrors both steps, the gate after the build it reads', () => {
    const build = VERIFY.indexOf('run_step "build:prod"          npm run build:prod');
    const gate = VERIFY.indexOf('run_step "mock-isolation gate" npm run check:mock-isolation');
    assert.ok(build > 0 && gate > build);
    assert.match(VERIFY, /run_step "guard qualification tests[^"]*" npm run test:guards/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('executed: the real gate through the real package script', () => {
  let ws;
  before(() => {
    ws = makeWorkspace();
    writeSyntheticDist(ws);
  });
  after(() => ws.cleanup());

  it('CONTROL: a clean tree and a complete output pass, and say how much they inspected', () => {
    const r = ws.npm('run', 'check:mock-isolation');
    assert.equal(r.status, EXIT.CLEAN, r.output);
    assert.match(r.output, /self-test: OK/);
    assert.match(r.output, /production module\(s\) walked from src\/main\.ts/);
    assert.match(r.output, /index\.html loads 2 entry script\(s\); 2 chunk\(s\) reached through module imports/);
    assert.match(r.output, /OK — complete scan/);
  });

  const broken = [
    ['the marker matcher', 'return FORBIDDEN_MARKERS.filter(({ marker }) => content.includes(marker));', 'return [];'],
    ['output discovery', 'names = [...fsx.readdir(dir)].sort();', 'names = [];'],
    ['the import walker', 'for (const ref of moduleReferences(compiled, text)) {', 'for (const ref of []) {'],
    ['the chunk-reference reader', 'for (const match of content.matchAll(JS_REFERENCE)) {', 'for (const match of []) {'],
  ];
  for (const [what, find, replace] of broken) {
    it(`REGRESSION: breaking ${what} fails the required check although the tree is clean`, () => {
      const saved = ws.read(GATE_SCRIPT);
      try {
        ws.mutate(GATE_SCRIPT, find, replace);
        const r = ws.npm('run', 'check:mock-isolation');
        assert.equal(r.status, EXIT.SELF_TEST, r.output);
        assert.match(r.output, /self-test FAIL/);
        assert.doesNotMatch(r.output, /OK — complete scan/, 'no scan-clean claim from an untrusted detector');
      } finally {
        ws.write(GATE_SCRIPT, saved);
      }
    });
  }

  it('NEGATIVE CONTROL: with the self-test dropped from the package script, the same broken matcher reports shipped mock code as clean', () => {
    const script = ws.read(GATE_SCRIPT);
    const pkg = ws.read('package.json');
    try {
      ws.mutate(GATE_SCRIPT, 'return FORBIDDEN_MARKERS.filter(({ marker }) => content.includes(marker));', 'return [];');
      ws.mutate('package.json', '"node scripts/check-mock-isolation.mjs --self-test && node scripts/check-mock-isolation.mjs"', '"node scripts/check-mock-isolation.mjs"');
      writeSyntheticDist(ws, { 'dist/chunk-E5.js': 'console.warn("DINIFY_ADMIN_MOCK_AUTH_PRESENT");export const x=1;' });
      const r = ws.npm('run', 'check:mock-isolation');
      assert.equal(r.status, EXIT.CLEAN, 'this is the harm the CONTRACT on the package script prevents');
    } finally {
      ws.write(GATE_SCRIPT, script);
      ws.write('package.json', pkg);
      writeSyntheticDist(ws);
    }
  });

  it('REGRESSION: the CI step’s own shell carries the gate’s status — clean, violation, incomplete and self-test failure', () => {
    const step = VALIDATE[indexOfRun(VALIDATE, GATE)];
    const body = `cd '${ws.dir}' && PATH='${NODE_DIR}':"$PATH" exec '${process.execPath}' '${NPM_CLI}' --silent "$@"`;
    const run = () => runStep(step.run, { npmBody: body }).status;
    const script = ws.read(GATE_SCRIPT);
    try {
      assert.equal(run(), EXIT.CLEAN);
      writeSyntheticDist(ws, { 'dist/chunk-E5.js': 'console.warn("DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT");' });
      assert.equal(run(), EXIT.VIOLATION);
      writeSyntheticDist(ws, { 'dist/chunk-E5.js': null });
      assert.equal(run(), EXIT.INCOMPLETE);
      writeSyntheticDist(ws);
      ws.mutate(GATE_SCRIPT, 'return FORBIDDEN_MARKERS.filter(({ marker }) => content.includes(marker));', 'return [];');
      assert.equal(run(), EXIT.SELF_TEST);
    } finally {
      ws.write(GATE_SCRIPT, script);
      writeSyntheticDist(ws);
    }
  });

  it('NEGATIVE CONTROL: a `|| true` or a pipe under the default shell would swallow the failure — which the CONTRACT forbids', () => {
    assert.equal(runStep(`${GATE} || true\n`, { npmExit: 2 }).status, 0);
    assert.equal(runStep(`${GATE} | tee gate.log\n`, { npmExit: 2 }).status, 0);
    assert.notDeepEqual(statusSwallowers(`${GATE} || true`), []);
  });

  it('REGRESSION MATRIX: `validate` stays red when this gate — or its qualification — fails, whatever else passes, and evidence retention does not rescue it', () => {
    for (const failing of [GATE, GUARDS]) {
      const result = simulateJob(VALIDATE, (step) => (commandOf(step) === failing ? 'failure' : 'success'));
      assert.equal(result.conclusion, 'failure', failing);
      assert.ok(result.ran.some(([name, outcome]) => /Retain/.test(name) && outcome === 'success'), 'retention still runs');
      assert.ok(result.ran.some(([name, outcome]) => /scan the validated inventory/.test(name) && outcome === 'skipped'));
    }
    assert.equal(simulateJob(VALIDATE, () => 'success').conclusion, 'success', 'CONTROL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('build-output coverage: an absent, empty or partial output is never clean', () => {
  let ws;
  before(() => {
    ws = makeWorkspace();
  });
  after(() => ws.cleanup());

  const gate = () => ws.npm('run', 'check:mock-isolation');
  const cases = [
    ['no output directory at all', () => ws.remove('dist'), /dist\/ does not exist/],
    ['an empty output directory', () => { ws.remove('dist'); ws.write('dist/.keep', ''); }, /index\.html is missing/],
    ['an index.html that loads no JavaScript', () => { ws.remove('dist'); ws.write('dist/index.html', '<html><link rel="stylesheet" href="s.css"></html>'); ws.write('dist/s.css', 'a{}'); }, /loads no JavaScript application entry/],
    ['a directory holding only harmless CSS', () => { ws.remove('dist'); ws.write('dist/styles.css', 'a{}'); }, /index\.html is missing/],
    ['an entry script index.html names but the output lacks', () => writeSyntheticDist(ws, { 'dist/main-D4.js': null }), /references main-D4\.js, which dist\/ does not contain/],
    ['a lazy chunk an entry imports but the output lacks', () => writeSyntheticDist(ws, { 'dist/chunk-E5.js': null }), /imports chunk-E5\.js/],
    ['a symbolic link inside the output', () => { writeSyntheticDist(ws); symlinkSync('.', ws.path('dist/loop')); }, /symbolic link — refused/],
  ];
  for (const [label, arrange, explanation] of cases) {
    it(`REGRESSION: ${label} is INCOMPLETE, with the reason, never scan-clean`, () => {
      arrange();
      const r = gate();
      assert.equal(r.status, EXIT.INCOMPLETE, r.output);
      assert.match(r.output, explanation);
      assert.match(r.output, /INCOMPLETE — the scan did not cover what it claims to/);
      assert.doesNotMatch(r.output, /OK — complete scan/);
    });
  }

  it('REGRESSION: the output directory is the one angular.json names, not a guessed dist/', () => {
    const angular = ws.read('angular.json');
    try {
      writeSyntheticDist(ws);
      ws.mutate('angular.json', '"base": "dist"', '"base": "build-output"');
      const r = gate();
      assert.equal(r.status, EXIT.INCOMPLETE, r.output);
      assert.match(r.output, /build-output\/ does not exist/);
    } finally {
      ws.write('angular.json', angular);
    }
  });

  it('REGRESSION: a marker in a nested lazy chunk that index.html never names is found', () => {
    writeSyntheticDist(ws, {
      'dist/chunk-E5.js': 'import"./nested/chunk-F6.js";export const x=1;',
      'dist/nested/chunk-F6.js': 'document.body.setAttribute("data-build-marker","DINIFY_ADMIN_GALLERY_PRESENT");',
    });
    const r = gate();
    assert.equal(r.status, EXIT.VIOLATION, r.output);
    assert.match(r.output, /dist\/nested\/chunk-F6\.js carries DINIFY_ADMIN_GALLERY_PRESENT/);
    assert.doesNotMatch(ws.read('dist/index.html'), /chunk-F6/, 'the chunk is reachable only through module imports');
  });

  it('CONTROL: ordinary strings that merely resemble the markers do not trip the gate', () => {
    writeSyntheticDist(ws, { 'dist/chunk-E5.js': 'const DINIFY_ADMIN=1,mock="mock",gallery="Gallery";export const x=DINIFY_ADMIN;' });
    const r = gate();
    assert.equal(r.status, EXIT.CLEAN, r.output);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('simulated reader failures are reported, never skipped (deterministic as root)', () => {
  const root = resolve('/sim');
  const out = join(root, 'dist');
  const tree = {
    'index.html': '<script src="main.js" type="module"></script>',
    'main.js': 'import("./lazy.js");',
    'lazy.js': 'export const x=1;',
    media: { 'f.woff2': 'x' },
  };
  const stat = (kind) => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' });
  const fs = (failing) => ({
    lstat(p) {
      if (failing.lstat === p) throw Object.assign(new Error('x'), { code: 'EIO' });
      const parts = p.slice(out.length + 1).split('/').filter(Boolean);
      let at = tree;
      for (const part of parts) at = at?.[part];
      if (at === undefined) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return stat(typeof at === 'string' ? 'file' : 'dir');
    },
    readdir(p) {
      if (failing.readdir === p) throw Object.assign(new Error('x'), { code: 'EACCES' });
      const parts = p.slice(out.length + 1).split('/').filter(Boolean);
      let at = tree;
      for (const part of parts) at = at[part];
      return Object.keys(at);
    },
    readFile(p) {
      if (failing.readFile === p) throw Object.assign(new Error('x'), { code: 'EACCES' });
      const parts = p.slice(out.length + 1).split('/');
      let at = tree;
      for (const part of parts) at = at[part];
      return at;
    },
  });

  it('CONTROL: the simulated tree is complete when nothing fails', () => {
    assert.deepEqual(scanBuildOutput(out, { fsx: fs({}), root }).incomplete, []);
  });
  for (const [label, failing, reason] of [
    ['an unreadable lazy chunk', { readFile: join(out, 'lazy.js') }, /dist\/lazy\.js could not be read \(EACCES\)/],
    ['an unlistable directory', { readdir: join(out, 'media') }, /dist\/media\/ could not be listed \(EACCES\)/],
    ['an entry that cannot be inspected', { lstat: join(out, 'main.js') }, /dist\/main\.js could not be inspected \(EIO\)/],
    ['an unreadable output root', { lstat: out }, /dist\/ could not be read \(EIO\)/],
  ]) {
    it(`REGRESSION: ${label} makes the scan incomplete and says which file`, () => {
      const result = scanBuildOutput(out, { fsx: fs(failing), root });
      assert.ok(result.incomplete.some((line) => reason.test(line)), result.incomplete.join('\n'));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────
describe('the source boundary over the real tree', () => {
  const contract = readBuildContract(ROOT);
  const { options } = readCompilerOptions(contract.tsConfig);
  const analyse = (overlay = new Map(), replacements = contract.replacements) =>
    analyseSourceBoundary({ root: ROOT, entries: contract.entries, replacements, compilerOptions: options, host: fileSystemHost(ROOT, overlay) });
  const DEV = join(ROOT, 'src/app/dev');
  const SEAM_TARGET = 'src/app/dev/dev-tools.prod.ts';
  const CONFIG = join(ROOT, 'src/app/app.config.ts');

  it('CONTROL: the production graph reaches the replaced seam and nothing else in src/app/dev', () => {
    assert.deepEqual(contract.incomplete, []);
    const result = analyse();
    assert.deepEqual(result.incomplete, []);
    assert.deepEqual(result.violations, []);
    const dev = result.modules.filter((m) => m.compiled.startsWith('src/app/dev/'));
    assert.deepEqual(dev, [{ path: 'src/app/dev/dev-tools.ts', compiled: SEAM_TARGET }]);
  });

  // Enumerated from disk, so a development-only module added later is covered with no
  // edit here. The seam itself is excluded: importing `dev-tools` IS the legitimate
  // production path, because the build replaces it — the test after this matrix removes
  // the replacement and proves the seam is refused then.
  const seam = new Set([...contract.replacements].flatMap(([from, to]) => [from, to]).map((p) => p.slice(ROOT.length + 1)));
  const devModules = readdirSync(DEV).filter((name) => /\.ts$/.test(name) && !seam.has(`src/app/dev/${name}`));
  it('CONTRACT: every current development-only module is in the matrix below, and only the seam is exempt', () => {
    assert.ok(seam.has('src/app/dev/dev-tools.ts') && seam.has(SEAM_TARGET));
    for (const name of ['mock-admin-auth.ts', 'mock-restaurant-api.ts', 'mock-restaurants.fixtures.ts', 'mock-http-error.ts', 'gallery.page.ts']) {
      assert.ok(devModules.includes(name), name);
    }
  });
  for (const name of devModules) {
    it(`REGRESSION MATRIX: a production module that imports and uses ${name} directly is refused`, () => {
      const probe = `${readFileSync(CONFIG, 'utf8')}\nimport * as devProbe from './dev/${name.replace(/\.ts$/, '')}';\nexport const DEV_PROBE = Object.keys(devProbe).length;\n`;
      const result = analyse(new Map([[CONFIG, probe]]));
      const hit = result.violations.find((v) => v.file === `src/app/dev/${name}`);
      assert.ok(hit, JSON.stringify(result.violations));
      assert.deepEqual(hit.chain.slice(-2), ['src/app/app.config.ts', `src/app/dev/${name}`]);
    });
  }

  it('REGRESSION: a test source that becomes part of the production graph is refused', () => {
    const main = join(ROOT, 'src/main.ts');
    const result = analyse(new Map([[main, `${readFileSync(main, 'utf8')}\nimport './app/app.routes.spec';\n`]]));
    assert.ok(result.violations.some((v) => v.kind === 'test' && v.file === 'src/app/app.routes.spec.ts'));
  });

  it('REGRESSION: without the production replacement, the seam and every mock behind it are refused', () => {
    const replacements = new Map([...contract.replacements].filter(([from]) => !from.startsWith(DEV)));
    const files = analyse(new Map(), replacements).violations.map((v) => v.file);
    for (const file of ['dev-tools.ts', 'mock-admin-auth.ts', 'mock-restaurant-api.ts', 'mock-restaurants.fixtures.ts', 'mock-http-error.ts', 'gallery.page.ts']) {
      assert.ok(files.includes(`src/app/dev/${file}`), file);
    }
  });

  it('REGRESSION: a build shape the gate does not model is incomplete, not silently unexamined', () => {
    const angular = JSON.parse(readFileSync(join(ROOT, 'angular.json'), 'utf8'));
    angular.projects.dinify_admin.architect.build.options.server = 'src/main.server.ts';
    const result = readBuildContract(ROOT, { readText: () => JSON.stringify(angular) });
    assert.ok(result.incomplete.some((line) => /"server"/.test(line)));
  });

  it('CONTROL: a package polyfill is external, a local polyfill under src/app/dev is walked and refused', () => {
    assert.deepEqual(contract.entries.map((e) => e.slice(ROOT.length + 1)), ['src/main.ts']);
    const withLocal = analyseSourceBoundary({
      root: ROOT, entries: [...contract.entries, join(DEV, 'mock-http-error.ts')], replacements: contract.replacements, compilerOptions: options, host: fileSystemHost(ROOT),
    });
    assert.ok(withLocal.violations.some((v) => v.file === 'src/app/dev/mock-http-error.ts'));
  });
});
