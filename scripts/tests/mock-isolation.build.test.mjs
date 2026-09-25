/**
 * ADMIN-MOCK-00 against REAL OPTIMIZED PRODUCTION BUILDS.
 *
 * Each scenario copies this workspace, breaks the production module graph the way a
 * real change would, runs the real `ng build --configuration=production` (the same
 * optimizer, file replacements and tree-shaking that ship), and then runs the real
 * `npm run check:mock-isolation` over what it produced.
 *
 * The build is asked for `--stats-json` — the esbuild metafile — so each scenario can
 * state, from the optimizer's own record, which development-only sources contributed
 * LIVE bytes to the output. That is what turns "the gate said no" into "the gate said
 * no to code that really shipped", and what makes the marker-free case below a proof
 * rather than an assertion: the fixture's bytes are in the bundle, its marker is not,
 * and only the source boundary stands between it and a green build.
 *
 * The metafile exists only in these disposable workspaces; the shipped build is not
 * given one (it would publish the source layout to the public origin).
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { EXIT, scanBuildOutput } from '../check-mock-isolation.mjs';
import { makeWorkspace } from './workspace.mjs';

const BUILD_TIMEOUT_MS = 240_000;

function build(ws) {
  const r = spawnSync(process.execPath, [ws.path('node_modules/@angular/cli/bin/ng.js'), 'build', '--configuration=production', '--stats-json'], {
    cwd: ws.dir,
    env: { ...process.env, NG_CLI_ANALYTICS: 'false', CI: 'true' },
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  assert.equal(r.status, 0, `the production build itself failed:\n${r.stdout}${r.stderr}`);
}

/** Source file -> bytes it contributed to the emitted JavaScript, per the optimizer. */
function liveBytes(ws) {
  const meta = JSON.parse(ws.read('dist/stats.json'));
  const bytes = new Map();
  for (const output of Object.values(meta.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs ?? {})) {
      bytes.set(input, (bytes.get(input) ?? 0) + bytesInOutput);
    }
  }
  return { inputs: Object.keys(meta.inputs), bytes };
}

function scenario(label, arrange, check) {
  it(label, { timeout: BUILD_TIMEOUT_MS * 2 }, (t) => {
    const ws = makeWorkspace('dinify-admin-build-');
    try {
      arrange(ws);
      build(ws);
      const gate = ws.npm('run', 'check:mock-isolation');
      const meta = liveBytes(ws);
      // Evidence in the log: what the optimizer kept from src/app/dev, and the verdict.
      const dev = [...meta.bytes].filter(([input]) => input.startsWith(DEV_PREFIX)).map(([input, n]) => `${input}=${n}B`);
      t.diagnostic(`live src/app/dev bytes: ${dev.join(', ') || 'none'}`);
      t.diagnostic(`gate exit ${gate.status}: ${gate.output.split('\n').filter((line) => /^\s+(source|output):|Mock-isolation gate: /.test(line)).join(' | ')}`);
      check({ ws, gate, meta });
    } finally {
      ws.cleanup();
    }
  });
}

const DEV_PREFIX = 'src/app/dev/';

describe('the gate against real optimized production builds', () => {
  scenario('CONTROL: the unmodified app builds, passes, and the walker covers every module the optimizer compiled', () => {}, ({ ws, gate, meta }) => {
    assert.equal(gate.status, EXIT.CLEAN, gate.output);
    assert.match(gate.output, /OK — complete scan/);
    // Agreement: every TypeScript source the real build read is one the walker reached.
    // (`src/styles.css` is a stylesheet entry, not a module.) A walker that missed a
    // module the build compiles would be checking a smaller program than the one shipped.
    const walked = JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { readBuildContract, readCompilerOptions, analyseSourceBoundary, fileSystemHost } from ${JSON.stringify(ws.path('scripts/check-mock-isolation.mjs'))};
      const root = ${JSON.stringify(ws.dir)};
      const c = readBuildContract(root);
      const r = analyseSourceBoundary({ root, entries: c.entries, replacements: c.replacements, compilerOptions: readCompilerOptions(c.tsConfig).options, host: fileSystemHost(root) });
      process.stdout.write(JSON.stringify(r.modules.map((m) => m.path)));
    `], { encoding: 'utf8' }).stdout);
    const compiled = meta.inputs.filter((input) => input.startsWith('src/') && /\.ts$/.test(input));
    assert.ok(compiled.length > 30, 'the metafile names the application sources');
    assert.deepEqual(compiled.filter((input) => !walked.includes(input)), []);
    // The only src/app/dev path in the build is the seam, and what it contributes is the
    // empty production stand-in, not the mock wiring.
    const dev = compiled.filter((input) => input.startsWith(DEV_PREFIX));
    assert.deepEqual(dev, ['src/app/dev/dev-tools.ts']);
    assert.ok(meta.bytes.get('src/app/dev/dev-tools.ts') < 64, `seam bytes: ${meta.bytes.get('src/app/dev/dev-tools.ts')}`);
  });

  scenario(
    'REGRESSION: marker-free development code imported directly survives the optimizer with no marker — only the source boundary catches it',
    (ws) => {
      ws.write('src/main.ts', `${ws.read('src/main.ts')}
import { MOCK_RESTAURANT_ROWS } from './app/dev/mock-restaurants.fixtures';
import { MockHttpError } from './app/dev/mock-http-error';
(globalThis as unknown as Record<string, unknown>)['__dinifyProbe'] = [MOCK_RESTAURANT_ROWS.length, new MockHttpError(0, null)];
`);
    },
    ({ ws, gate, meta }) => {
      // The optimizer's own record: both modules' code is LIVE in the output.
      assert.ok(meta.bytes.get('src/app/dev/mock-restaurants.fixtures.ts') > 1000, 'the synthetic portfolio shipped');
      assert.ok(meta.bytes.get('src/app/dev/mock-http-error.ts') > 50, 'the mock error class shipped');
      // The marker half alone would call this build clean — which is what the gate
      // before B2.3 did.
      const output = scanBuildOutput(ws.path('dist'), { root: ws.dir });
      assert.deepEqual(output.incomplete, []);
      assert.deepEqual(output.markers, [], 'neither module carries a marker');
      // The gate refuses it, naming both sources and the path that reaches them.
      assert.equal(gate.status, EXIT.VIOLATION, gate.output);
      assert.match(gate.output, /source: src\/app\/dev\/mock-restaurants\.fixtures\.ts is development-only and is in the production module graph \(src\/main\.ts -> src\/app\/dev\/mock-restaurants\.fixtures\.ts\)/);
      assert.match(gate.output, /source: src\/app\/dev\/mock-http-error\.ts is development-only/);
    },
  );

  scenario(
    'REGRESSION: a dormant fileReplacements entry naming a dev file as its target does not exempt a direct production import of that file',
    (ws) => {
      // Codex review of PR #30 (P1). `environment.live.ts` exists and nothing in the
      // production graph imports it, so this replacement never fires — it only NAMES the
      // fixtures as a target. Replacement targets used to be a global allowlist, so that
      // naming alone exempted the direct import below and the gate exited 0.
      const angular = JSON.parse(ws.read('angular.json'));
      angular.projects.dinify_admin.architect.build.configurations.production.fileReplacements.push({
        replace: 'src/environments/environment.live.ts',
        with: 'src/app/dev/mock-restaurants.fixtures.ts',
      });
      ws.write('angular.json', `${JSON.stringify(angular, null, 2)}\n`);
      ws.write('src/main.ts', `${ws.read('src/main.ts')}
import { MOCK_RESTAURANT_ROWS } from './app/dev/mock-restaurants.fixtures';
(globalThis as unknown as Record<string, unknown>)['__dinifyProbe'] = MOCK_RESTAURANT_ROWS.length;
`);
    },
    ({ ws, gate, meta }) => {
      assert.ok(meta.bytes.get('src/app/dev/mock-restaurants.fixtures.ts') > 1000, 'the synthetic portfolio shipped');
      assert.deepEqual(scanBuildOutput(ws.path('dist'), { root: ws.dir }).markers, [], 'and carries no marker');
      assert.equal(gate.status, EXIT.VIOLATION, gate.output);
      assert.match(gate.output, /source: src\/app\/dev\/mock-restaurants\.fixtures\.ts is development-only and is in the production module graph \(src\/main\.ts -> src\/app\/dev\/mock-restaurants\.fixtures\.ts\)/);
    },
  );

  scenario(
    'REGRESSION: a mock provider wired eagerly and the gallery routed lazily are caught by BOTH halves, in the initial bundle and in a lazy chunk',
    (ws) => {
      ws.mutate('src/app/app.config.ts', '    ...DEV_PROVIDERS,\n', "    ...DEV_PROVIDERS,\n    { provide: ADMIN_AUTH, useClass: MockAdminAuthApi },\n");
      ws.write('src/app/app.config.ts', `import { MockAdminAuthApi } from './dev/mock-admin-auth';\n${ws.read('src/app/app.config.ts')}`);
      ws.mutate('src/app/app.routes.ts', '      ...DEV_ROUTES,\n', "      ...DEV_ROUTES,\n      { path: '__probe', loadComponent: () => import('./dev/gallery.page').then((m) => m.GalleryPage) },\n");
    },
    ({ ws, gate, meta }) => {
      assert.ok(meta.bytes.get('src/app/dev/mock-admin-auth.ts') > 1000);
      assert.ok(meta.bytes.get('src/app/dev/gallery.page.ts') > 1000);
      assert.equal(gate.status, EXIT.VIOLATION, gate.output);
      assert.match(gate.output, /source: src\/app\/dev\/mock-admin-auth\.ts is development-only/);
      assert.match(gate.output, /source: src\/app\/dev\/gallery\.page\.ts is development-only/);
      assert.match(gate.output, /carries DINIFY_ADMIN_MOCK_AUTH_PRESENT/);
      const lazy = gate.output.match(/output: (dist\/\S+) carries DINIFY_ADMIN_GALLERY_PRESENT/);
      assert.ok(lazy, gate.output);
      const index = ws.read('dist/index.html');
      assert.ok(!index.includes(lazy[1].slice('dist/'.length)), 'the gallery marker is in a chunk index.html never names — reached only as a lazy import');
    },
  );

  scenario(
    'REGRESSION: removing the production file replacement puts the whole mock seam back, and the gate names it',
    (ws) => {
      const angular = JSON.parse(ws.read('angular.json'));
      const production = angular.projects.dinify_admin.architect.build.configurations.production;
      production.fileReplacements = production.fileReplacements.filter((r) => !r.replace.startsWith(DEV_PREFIX));
      ws.write('angular.json', `${JSON.stringify(angular, null, 2)}\n`);
    },
    ({ gate, meta }) => {
      assert.ok(meta.bytes.get('src/app/dev/mock-restaurant-api.ts') > 1000);
      assert.equal(gate.status, EXIT.VIOLATION, gate.output);
      for (const file of ['dev-tools.ts', 'mock-admin-auth.ts', 'mock-restaurant-api.ts', 'mock-restaurants.fixtures.ts', 'mock-http-error.ts', 'gallery.page.ts']) {
        assert.match(gate.output, new RegExp(`source: src/app/dev/${file.replace(/\./g, '\\.')} is development-only`), file);
      }
      assert.match(gate.output, /carries DINIFY_ADMIN_MOCK_RESTAURANTS_PRESENT/);
    },
  );
});
