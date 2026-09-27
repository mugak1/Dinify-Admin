/**
 * THE FRESH ASSESSMENT'S DIAGNOSTIC HALF: what `collect()` keeps of the scanner's own
 * debug log, and what it refuses to keep.
 *
 * Readiness run 36283185235 went red because the application scan hit the policy timeout,
 * and the only evidence it retained was an empty stdout, an empty stderr and a SIGTERM:
 * npm writes its record of what it was doing to a debug log, and nothing kept that log.
 * The cause of that run stays unknown. What this suite pins is narrower: from now on the
 * assessment keeps a SANITIZED, BOUNDED projection of that log for each graph, so the last
 * events npm recorded can be read afterwards — never a claim about which request stalled.
 *
 * The scanner here is an injected runner that behaves as npm does with `--logs-dir`: it
 * resolves the value against its OWN cwd and writes numbered log lines in npm 11's format
 * (read from npm 11.19.1's source and from its real logs). The real pinned npm writing a
 * real log on termination is recorded in release/README.md, not re-run here.
 */

import { strict as assert } from 'node:assert';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  DIAGNOSTIC_MAX_BYTES, DIAGNOSTIC_READ_WINDOW, checkDiagnosticProjection, collect, readDiagnosticEvents,
} from '../lib/retained.mjs';
import { inventory, sha256 } from '../lib/npm.mjs';
import { makeProject, npmReport } from './project.mjs';

const LINUX = { node: 'v24.21.0', platform: 'linux', arch: 'x64', libc: 'glibc' };
const POLICY = { scanner: { registry: 'https://registry.npmjs.org/', timeoutSeconds: 60 } };
const NPM_CLI = '/nonexistent/npm-cli.js';
const BULK = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 27, 12, 0, tick++)).toISOString().replace(/\.000Z$/, 'Z');

/** Every path under `dir`, relative, sorted — what "unchanged" is measured against. */
function listing(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** The `--logs-dir` value a scanner invocation was given, or null. */
const logsArg = (args) => {
  const a = args.find((x) => x.startsWith('--logs-dir='));
  return a ? a.slice('--logs-dir='.length) : null;
};

/**
 * A scanner stand-in that writes npm's debug log where npm would: `--logs-dir` resolved
 * against the scanner's cwd. `lines` are npm-format messages; each gets npm's number.
 */
function npmLike({ lines, answer = { status: 0, stdout: npmReport({}, 4) }, name } = {}) {
  const calls = [];
  const runner = (call) => {
    calls.push(call);
    const value = logsArg(call.args);
    if (value !== null && lines) {
      const dir = resolve(call.cwd, value);
      mkdirSync(dir, { recursive: true });
      const file = name ?? `${new Date().toISOString().replace(/[.:]/g, '_')}-debug-0.log`;
      writeFileSync(join(dir, file), lines.map((l, i) => `${i} ${l}\n`).join(''));
    }
    return { command: call.command, args: call.args, cwd: call.cwd, status: 0, signal: null, timedOut: false, error: null, stdout: '', stderr: '', durationMs: 1, ...answer };
  };
  runner.calls = calls;
  return runner;
}

const HEALTHY_LOG = [
  'verbose cli /usr/bin/node /opt/scanner/node_modules/npm/bin/npm-cli.js',
  'info using npm@11.19.1',
  'silly audit bulk request {',
  `http fetch POST 200 ${BULK} 147ms`,
  'silly audit report {',
  'silly packumentCache corgi:https://registry.npmjs.org/stream-json cache-miss',
  'http fetch GET 200 https://registry.npmjs.org/stream-json 67ms (cache miss)',
  'verbose cwd /home/runner/work/x/assessment-replay',
  'verbose exit 1',
  'verbose code 1',
];

/** A project, an absolute scratch root outside it, and cleanup for both. */
function setup() {
  const p = makeProject({});
  const scratch = mkdtempSync(join(tmpdir(), 'dinify-diag-test-'));
  const evidence = join(scratch, 'evidence');
  mkdirSync(evidence);
  const logsRoot = mkdtempSync(join(tmpdir(), 'dinify-diag-logs-'));
  const inv = inventory(p.root, { graph: 'application', env: LINUX });
  return {
    root: p.root, inv, evidence, logsRoot,
    cleanup: () => { p.cleanup(); rmSync(scratch, { recursive: true, force: true }); rmSync(logsRoot, { recursive: true, force: true }); },
  };
}

const run = (s, runner, extra = {}) => collect({
  graph: 'application', dir: s.root, kind: 'installed', inv: s.inv, npmCli: NPM_CLI, policy: POLICY, runner, clock,
  evidenceDir: s.evidence, env: LINUX, baseEnv: {}, diagnostics: { root: s.logsRoot, forbidden: [s.root, s.evidence] }, ...extra,
});

describe('REGRESSION (run 36283185235): the scanner\'s own record of what it was doing is kept', () => {
  it('REGRESSION: a scan retains a sanitized diagnostic file for its graph, hashed exactly as written', () => {
    const s = setup();
    try {
      const c = run(s, npmLike({ lines: HEALTHY_LOG }));
      assert.deepEqual(c.problems, [], JSON.stringify(c.problems));
      const d = c.record.diagnostics;
      assert.ok(d, 'the graph record carries a diagnostic descriptor');
      assert.equal(d.state, 'retained', JSON.stringify(d));
      assert.equal(d.file, 'application.npm-diagnostics.txt');
      const bytes = readFileSync(join(s.evidence, d.file));
      assert.equal(d.bytes, bytes.length);
      assert.equal(d.sha256, sha256(bytes));
      assert.match(bytes.toString('utf8'), /http-complete POST 200 https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk 147ms/);
    } finally { s.cleanup(); }
  });

  it('REGRESSION (relative output path): the log directory npm is given is ABSOLUTE and outside everything scanned or uploaded', () => {
    const s = setup();
    const work = mkdtempSync(join(tmpdir(), 'dinify-diag-cwd-'));
    const was = process.cwd();
    try {
      // The CLI's usual `--out assessment` is RELATIVE, and npm runs in each graph's own
      // directory: a relative log path would resolve INSIDE the graph being scanned.
      process.chdir(work);
      mkdirSync('assessment');
      const before = listing(s.root);
      const runner = npmLike({ lines: HEALTHY_LOG });
      const c = run(s, runner, { evidenceDir: 'assessment', diagnostics: { root: s.logsRoot, forbidden: [s.root, 'assessment'] } });
      const value = logsArg(runner.calls[0].args);
      assert.ok(value, 'the scanner was told where to write its log');
      assert.ok(isAbsolute(value), `the log directory is absolute: ${value}`);
      for (const inside of [s.root, resolve('assessment')]) {
        assert.ok(relative(inside, value).startsWith('..'), `${value} is outside ${inside}`);
      }
      assert.deepEqual(listing(s.root), before, 'nothing was written into the scanned graph');
      assert.equal(c.record.diagnostics.state, 'retained');
      assert.deepEqual(readdirSync(resolve('assessment')).sort(), ['application.npm-diagnostics.txt', 'application.scanner-stderr.txt', 'application.scanner-stdout.txt']);
    } finally {
      process.chdir(was);
      rmSync(work, { recursive: true, force: true });
      s.cleanup();
    }
  });
});

describe('what is kept is a SANITIZED projection — never the raw log', () => {
  const HOSTILE = [
    'verbose argv "audit" "--registry" "https://alice:s3cr3t-pw@registry.example.com/"',
    'silly config npm_config__authToken=NPM-TOKEN-VALUE',
    'verbose cwd /home/runner/private-project',
    'verbose stack Error: boom at /home/runner/private-project/x.js:1:1',
    '\u001b[31merror\u001b[0m coloured',
    `${'x'.repeat(5000)}`,
    'silly audit bulk request {',
    'http fetch GET 200 https://bob:hunter2@registry.npmjs.org/pkg?token=qs-secret#frag 5ms (cache miss)',
    'http fetch GET 200 https://registry.npmjs.org/<script>alert(1)</script> 5ms',
    `warn audit request to ${BULK} failed, reason: Authorization: Bearer abc.def <b>x</b> socket hang up ECONNRESET`,
    "verbose audit error   code: 'ECONNRESET',",
    'verbose exit 1',
  ];

  it('CONTRACT: credentials, queries, paths, argv, config, markup and control characters never reach the retained bytes', () => {
    const s = setup();
    try {
      const c = run(s, npmLike({ lines: HOSTILE }));
      assert.equal(c.record.diagnostics.state, 'retained');
      const bytes = readFileSync(join(s.evidence, c.record.diagnostics.file));
      assert.ok(bytes.every((b) => b === 0x0a || (b >= 0x20 && b <= 0x7e)), 'printable ASCII and newlines only');
      const text = bytes.toString('latin1');
      for (const secret of ['s3cr3t', 'alice', 'hunter2', 'bob', 'qs-secret', 'frag', 'NPM-TOKEN', 'authToken', 'Bearer', 'abc.def', 'private-project',
        '/home/runner', 'script', 'alert', '<b>', 'socket hang up', 'coloured', 'xxxxxxxxxx', 'registry.example.com']) {
        assert.ok(!text.includes(secret), `${JSON.stringify(secret)} was retained`);
      }
      assert.match(text, /^# dinify\.npm-diagnostic-events\/1: SANITIZED npm events, NOT a complete raw log\n/);
      assert.match(text, /http-complete GET 200 https:\/\/<credentials-omitted>@registry\.npmjs\.org\/pkg\?<query-omitted> 5ms cache-miss/);
      assert.match(text, /http-complete GET 200 https:\/\/registry\.npmjs\.org\/<path-omitted> 5ms/);
      assert.match(text, new RegExp(`audit-request-failed ${BULK.replace(/[./]/g, '\\$&')} ECONNRESET`));
      assert.match(text, /audit-error-code ECONNRESET/);
      assert.match(text, /omitted \(not on the allowlist\): 6;/);
    } finally { s.cleanup(); }
  });
});

describe('one scan, one log: isolation, and the cases where nothing can be kept', () => {
  it('CONTRACT: each invocation gets its OWN fresh directory; a stale log beside it, or in HOME, is never read', () => {
    const s = setup();
    try {
      writeFileSync(join(s.logsRoot, '2026-01-01T00_00_00_000Z-debug-0.log'), `0 http fetch GET 200 https://registry.npmjs.org/STALE-ROOT 1ms\n`);
      const first = npmLike({ lines: ['http fetch GET 200 https://registry.npmjs.org/first-scan 1ms'] });
      const a = run(s, first);
      rmSync(join(s.evidence, a.record.diagnostics.file));
      const second = npmLike({ lines: ['http fetch GET 200 https://registry.npmjs.org/second-scan 1ms'] });
      const b = run(s, second);
      const [dirA, dirB] = [logsArg(first.calls[0].args), logsArg(second.calls[0].args)];
      assert.notEqual(dirA, dirB, 'two scans never share a log directory');
      const text = readFileSync(join(s.evidence, b.record.diagnostics.file), 'utf8');
      assert.match(text, /second-scan/);
      assert.ok(!/first-scan|STALE-ROOT/.test(text), 'only THIS scan\'s log');
      assert.equal(existsSync(dirA) || existsSync(dirB), false, 'each owned directory is removed after its scan');
      assert.ok(existsSync(join(s.logsRoot, '2026-01-01T00_00_00_000Z-debug-0.log')), 'nothing it did not create is removed');
    } finally { s.cleanup(); }
  });

  const cases = [
    ['no log at all', () => ({ lines: null }), 'no_log'],
    ['two logs — which to keep is not a choice made here', () => ({ lines: HEALTHY_LOG, extra: (dir) => writeFileSync(join(dir, '2026-09-27T00_00_00_001Z-debug-1.log'), '0 verbose exit 0\n') }), 'multiple_logs'],
    ['a link where the log should be', () => ({ lines: null, extra: (dir) => symlinkSync('/etc/hostname', join(dir, '2026-09-27T00_00_00_000Z-debug-0.log')) }), 'unsafe_entry'],
    ['a directory where the log should be', () => ({ lines: null, extra: (dir) => mkdirSync(join(dir, '2026-09-27T00_00_00_000Z-debug-0.log')) }), 'unsafe_entry'],
    ['a file npm would not name that way', () => ({ lines: null, extra: (dir) => writeFileSync(join(dir, 'notes.txt'), 'x') }), 'unsafe_entry'],
    ['a log directory that vanished before it could be read', () => ({ lines: null, extra: (dir) => rmSync(dir, { recursive: true }) }), 'unreadable'],
  ];
  for (const [what, make, reason] of cases) {
    it(`CONTRACT: ${what} → unavailable (${reason}), and the scan's own result is exactly the clean control's`, () => {
      const s = setup();
      try {
        const { lines, extra } = make();
        const inner = npmLike({ lines });
        const runner = (call) => {
          const r = inner(call);
          if (extra) { const dir = resolve(call.cwd, logsArg(call.args)); mkdirSync(dir, { recursive: true }); extra(dir); }
          return r;
        };
        const c = run(s, runner);
        assert.deepEqual(c.record.diagnostics, { state: 'unavailable', reason });
        assert.deepEqual(c.problems, []);
        assert.deepEqual(c.findings, []);
        assert.deepEqual(readdirSync(s.evidence).sort(), ['application.scanner-stderr.txt', 'application.scanner-stdout.txt'], 'no partial or undeclared file');
      } finally { s.cleanup(); }
    });
  }

  const locations = [
    ['a RELATIVE root', (s) => ({ root: relative(process.cwd(), s.logsRoot) }), 'unsafe_location'],
    ['a root INSIDE the scanned graph', (s) => { const d = join(s.root, 'logs'); mkdirSync(d); return { root: d }; }, 'unsafe_location'],
    ['a root that CONTAINS the evidence directory', (s) => ({ root: tmpdir(), forbidden: [s.evidence] }), 'unsafe_location'],
    ['a root that is a link', (s) => { const l = join(tmpdir(), `dinify-diag-link-${process.pid}-${tick}`); symlinkSync(s.logsRoot, l); return { root: l, cleanup: () => rmSync(l) }; }, 'unsafe_location'],
    ['a root that does not exist', (s) => ({ root: join(s.logsRoot, 'missing') }), 'setup_failed'],
  ];
  for (const [what, make, reason] of locations) {
    it(`CONTRACT: ${what} → unavailable (${reason}), and npm is given NO log directory at all`, () => {
      const s = setup();
      let made;
      try {
        made = make(s);
        const runner = npmLike({ lines: HEALTHY_LOG });
        const before = listing(s.root);
        const c = run(s, runner, { diagnostics: { root: made.root, forbidden: [s.root, s.evidence, ...(made.forbidden ?? [])] } });
        assert.deepEqual(c.record.diagnostics, { state: 'unavailable', reason });
        assert.equal(logsArg(runner.calls[0].args), null, 'the scanner ran exactly as it would without diagnostics');
        assert.deepEqual(c.problems, []);
        assert.deepEqual(listing(s.root), before);
      } finally { made?.cleanup?.(); s.cleanup(); }
    });
  }

  it('CONTRACT: a diagnostic that cannot be written is unavailable, and a file it did not create is left exactly as it was', () => {
    const s = setup();
    try {
      writeFileSync(join(s.evidence, 'application.npm-diagnostics.txt'), 'someone else\'s bytes');
      const c = run(s, npmLike({ lines: HEALTHY_LOG }));
      assert.deepEqual(c.record.diagnostics, { state: 'unavailable', reason: 'write_failed' });
      assert.equal(readFileSync(join(s.evidence, 'application.npm-diagnostics.txt'), 'utf8'), 'someone else\'s bytes');
      assert.deepEqual(c.problems, []);
    } finally { s.cleanup(); }
  });

  it('CONTROL: without the option, the scan is invoked and recorded exactly as before — no flag, no descriptor', () => {
    const s = setup();
    try {
      const runner = npmLike({ lines: HEALTHY_LOG });
      const c = run(s, runner, { diagnostics: null });
      assert.equal(logsArg(runner.calls[0].args), null);
      assert.equal(Object.hasOwn(c.record, 'diagnostics'), false);
    } finally { s.cleanup(); }
  });
});

describe('a timeout stays a timeout — the diagnostic never replaces or softens it', () => {
  const TIMED_OUT = { status: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: '', durationMs: 300035 };
  it('CONTRACT: a scan killed at the limit is scanner_timeout, with its partial log kept', () => {
    const s = setup();
    try {
      const c = run(s, npmLike({ lines: ['silly audit bulk request {', `http fetch POST 200 ${BULK} 12ms`, 'silly packumentCache corgi:https://registry.npmjs.org/stuck cache-miss'], answer: TIMED_OUT }));
      assert.deepEqual(c.problems.map((p) => p.code), ['scanner_timeout']);
      assert.equal(c.record.run.timedOut, true);
      assert.equal(c.record.run.stdoutBytes, 0);
      assert.equal(c.record.diagnostics.state, 'retained');
    } finally { s.cleanup(); }
  });
  it('CONTRACT: a scan killed at the limit whose diagnostic could not be kept is STILL scanner_timeout, and nothing else', () => {
    const s = setup();
    try {
      writeFileSync(join(s.evidence, 'application.npm-diagnostics.txt'), 'occupied');
      const c = run(s, npmLike({ lines: HEALTHY_LOG, answer: TIMED_OUT }));
      assert.deepEqual(c.problems.map((p) => p.code), ['scanner_timeout']);
      assert.deepEqual(c.record.diagnostics, { state: 'unavailable', reason: 'write_failed' });
    } finally { s.cleanup(); }
    const s2 = setup();
    try {
      const c2 = run(s2, npmLike({ lines: null, answer: TIMED_OUT }));
      assert.deepEqual(c2.problems.map((p) => p.code), ['scanner_timeout']);
      assert.deepEqual(c2.record.diagnostics, { state: 'unavailable', reason: 'no_log' });
    } finally { s2.cleanup(); }
  });
});

describe('bounded: a log is read from its END within a fixed window, and at most 1 MiB is kept', () => {
  it('CONTRACT: a 3 GiB log — larger than readFileSync will ever load — is still kept, from its last window only', () => {
    const s = setup();
    try {
      const runner = (call) => {
        const dir = resolve(call.cwd, logsArg(call.args));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, '2026-09-27T00_00_00_000Z-debug-0.log');
        writeFileSync(path, '0 http fetch GET 200 https://registry.npmjs.org/at-the-head 1ms\n');
        truncateSync(path, 3 * 1024 ** 3); // sparse: costs no disk
        appendFileSync(path, '\n7 http fetch GET 200 https://registry.npmjs.org/at-the-end 1ms\n8 verbose exit 1\n');
        return { command: call.command, args: call.args, cwd: call.cwd, status: 0, signal: null, timedOut: false, error: null, stdout: npmReport({}, 4), stderr: '', durationMs: 1 };
      };
      const c = run(s, runner);
      assert.equal(c.record.diagnostics.state, 'retained', JSON.stringify(c.record.diagnostics));
      assert.equal(c.record.diagnostics.truncated, true);
      const text = readFileSync(join(s.evidence, c.record.diagnostics.file), 'utf8');
      assert.match(text, new RegExp(`only its last ${DIAGNOSTIC_READ_WINDOW} bytes were read`));
      assert.match(text, /at-the-end/);
      assert.ok(!text.includes('at-the-head'), 'the head of the log was never read');
    } finally { s.cleanup(); }
  });

  it('CONTRACT: more events than fit — the OLDEST are dropped, the retained bytes never exceed 1 MiB, and truncation is stated', () => {
    const s = setup();
    try {
      const lines = Array.from({ length: 30000 }, (_, i) => `http fetch GET 200 https://registry.npmjs.org/pkg-${i} 1ms`);
      const c = run(s, npmLike({ lines }));
      const d = c.record.diagnostics;
      assert.equal(d.state, 'retained');
      assert.ok(d.bytes <= DIAGNOSTIC_MAX_BYTES, `${d.bytes} bytes`);
      assert.equal(d.truncated, true);
      const text = readFileSync(join(s.evidence, d.file), 'utf8');
      assert.match(text, /read whole/);
      assert.match(text, /oldest events dropped to fit 1048576 bytes: [1-9]\d*/);
      assert.match(text, /pkg-29999 1ms\n$/, 'the LAST event is kept');
      assert.ok(!/pkg-0 1ms/.test(text), 'the oldest was dropped');
    } finally { s.cleanup(); }
  });

  // The budget used to be measured against the header written with `kept 0 / dropped N`,
  // while the header actually written states the REAL kept and dropped counts — which can
  // be wider (500 kept + 1,500 dropped is 3+4 digits; 0 + 2,000 is 1+4). A budget landing
  // in that gap produced bytes over the cap, and the whole diagnostic was then discarded
  // as capture_failed: the over-full case this change exists for (Claude review on #709).
  it('REGRESSION: whatever the cap, an over-full log is TRUNCATED to fit it — never discarded because the real counts are wider than the budgeted ones', () => {
    const s = setup();
    try {
      const lines = Array.from({ length: 2000 }, (_, i) => `http fetch GET 200 https://registry.npmjs.org/p-${String(i).padStart(5, '0')} 1ms`);
      const width = '1999 http-complete GET 200 https://registry.npmjs.org/p-01999 1ms\n'.length;
      const lost = [];
      for (let maxBytes = 32000; maxBytes < 32000 + 2 * width; maxBytes += 1) {
        const c = run(s, npmLike({ lines }), { diagnostics: { root: s.logsRoot, forbidden: [s.root, s.evidence], limits: { maxBytes } } });
        const d = c.record.diagnostics;
        if (d.state !== 'retained') { lost.push(`${maxBytes}: ${d.reason}`); continue; }
        assert.ok(d.bytes <= maxBytes, `${d.bytes} bytes kept under a cap of ${maxBytes}`);
        assert.ok(d.bytes > maxBytes - width - 8, `${d.bytes} bytes under a cap of ${maxBytes}: more was dropped than the cap required`);
        assert.equal(d.truncated, true);
        rmSync(join(s.evidence, d.file));
      }
      assert.deepEqual(lost, [], 'no cap loses the diagnostic');
    } finally { s.cleanup(); }
  });

  it('CONTRACT: a window that starts mid-line drops the partial line, and a caller cannot raise the cap', () => {
    const s = setup();
    try {
      const lines = Array.from({ length: 40 }, (_, i) => `http fetch GET 200 https://registry.npmjs.org/pkg-${i} 1ms`);
      const c = run(s, npmLike({ lines }), { diagnostics: { root: s.logsRoot, forbidden: [s.root, s.evidence], limits: { readWindow: 300, maxBytes: 10 * DIAGNOSTIC_MAX_BYTES } } });
      const text = readFileSync(join(s.evidence, c.record.diagnostics.file), 'utf8');
      assert.match(text, /only its last 300 bytes were read/);
      for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) assert.match(line, /^\d+ http-complete GET 200 https:\/\/registry\.npmjs\.org\/pkg-\d+ 1ms$/);
      assert.equal(c.record.diagnostics.truncated, true);
    } finally { s.cleanup(); }
  });
});

describe('reading a kept diagnostic back: the last events, and what the log shows STARTED — never a cause', () => {
  const kept = (lines) => {
    const s = setup();
    try {
      const c = run(s, npmLike({ lines }));
      return readFileSync(join(s.evidence, c.record.diagnostics.file), 'latin1');
    } finally { s.cleanup(); }
  };

  it('CONTRACT: a COMPLETED request beside an unfinished one — the completed one is never listed as unfinished, even though it is the last completion', () => {
    const r = readDiagnosticEvents(kept([
      'silly audit bulk request {', `http fetch POST 200 ${BULK} 12ms`, 'silly audit report {',
      'silly packumentCache corgi:https://registry.npmjs.org/answered cache-miss',
      'silly packumentCache corgi:https://registry.npmjs.org/unanswered cache-miss',
      'http fetch GET 200 https://registry.npmjs.org/answered 9ms (cache miss)',
    ]));
    assert.deepEqual(r.unfinished, ['GET https://registry.npmjs.org/unanswered']);
    assert.match(r.last.at(-1), /http-complete GET 200 https:\/\/registry\.npmjs\.org\/answered 9ms/);
  });

  it('CONTRACT: the audit POST started with no completion is reported as started — and nothing else is invented', () => {
    assert.deepEqual(readDiagnosticEvents(kept(['silly audit bulk request {'])).unfinished, ['POST (the audit bulk advisory request)']);
  });

  // The shapes below are what the REAL pinned npm 11.19.1 wrote in the local probe recorded in
  // release/README.md ("Scanner diagnostics"). npm formats a logged object with util.inspect,
  // so a SMALL object is one line (`{ alpha: [ '1.0.0' ] }`, or `{}` for an empty report)
  // and a large one opens with a bare `{` and continues on lines of their own. The first
  // cut recognised only the bare opening, so the probe's POST stall kept no bulk-request
  // event at all — found by the probe, not by a fixture written from the same assumption.
  it('REGRESSION (real npm 11.19.1 line shapes): an INLINE bulk request and an EMPTY report are events; their contents and continuation lines are not', () => {
    const text = kept([
      "silly audit bulk request { alpha: [ '1.0.0' ], beta: [ '1.0.0' ] }",
      "silly audit report {}",
      'silly audit bulk request {',
      "silly audit bulk request   'secret-internal-pkg': [ '9.9.9' ],",
      'silly audit bulk request }',
      'silly audit report {',
      "silly audit report   'another-pkg': [",
      'silly audit report     {',
      'silly audit report }',
    ]);
    const events = text.split('\n').filter((l) => /^\d/.test(l));
    assert.deepEqual(events, ['0 audit-bulk-request-start', '1 audit-report-received', '2 audit-bulk-request-start', '5 audit-report-received']);
    for (const content of ['alpha', 'beta', '1.0.0', 'secret-internal-pkg', '9.9.9', 'another-pkg']) {
      assert.ok(!text.includes(content), `${JSON.stringify(content)} from inside a logged object was retained`);
    }
    assert.deepEqual(readDiagnosticEvents(kept(["silly audit bulk request { alpha: [ '1.0.0' ], beta: [ '1.0.0' ] }"])).unfinished,
      ['POST (the audit bulk advisory request)'], 'the probe\'s POST stall, as the real npm logged it');
  });

  it('REGRESSION: a bulk POST whose completion IS logged is never listed as unfinished, even with no report line after it', () => {
    // npm logs a 2xx request's http line when its response body ENDS (npm-registry-fetch
    // check-response.js), so this log records the POST as completed; stopping before the
    // `audit report` line says nothing about the POST.
    const r = readDiagnosticEvents(kept(['silly audit bulk request {', `http fetch POST 200 ${BULK} 12ms`]));
    assert.deepEqual(r.unfinished, []);
  });

  it('CONTROL: everything that started completed (a fetch or a cache hit) — nothing is listed', () => {
    const r = readDiagnosticEvents(kept([
      'silly audit bulk request {', `http fetch POST 200 ${BULK} 12ms`, 'silly audit report {',
      'silly packumentCache corgi:https://registry.npmjs.org/a cache-miss', 'http fetch GET 200 https://registry.npmjs.org/a 9ms',
      'silly packumentCache corgi:https://registry.npmjs.org/b cache-miss', 'http cache https://registry.npmjs.org/b 1ms (cache hit)',
    ]));
    assert.deepEqual(r.unfinished, []);
    assert.equal(r.count, 7);
  });
});

describe('the format\'s grammar — ONE definition, which the producer writes to and the receiver checks', () => {
  const keep = (lines, limits) => {
    const s = setup();
    try {
      const c = run(s, npmLike({ lines }), limits ? { diagnostics: { root: s.logsRoot, forbidden: [s.root, s.evidence], limits } } : {});
      assert.equal(c.record.diagnostics.state, 'retained', JSON.stringify(c.record.diagnostics));
      return { d: c.record.diagnostics, bytes: readFileSync(join(s.evidence, c.record.diagnostics.file)) };
    } finally { s.cleanup(); }
  };

  it('CONTRACT: whatever the producer keeps — ordinary, hostile, over-full or read from a window — the grammar accepts, stating the descriptor\'s own truncation', () => {
    const many = Array.from({ length: 30000 }, (_, i) => `http fetch GET 200 https://registry.npmjs.org/pkg-${i} 1ms`);
    for (const [what, lines, limits] of [
      ['ordinary', HEALTHY_LOG],
      ['every event shape', [
        'info using npm@11.19.1', 'info using node@v24.21.0', "silly audit bulk request { a: [ '1.0.0' ] }", 'silly audit report {}', 'silly audit report null',
        'silly packumentCache corgi:https://registry.npmjs.org/a cache-miss', 'http fetch GET 200 https://registry.npmjs.org/a 9ms attempt #2 (cache miss)',
        'http cache https://registry.npmjs.org/b 1ms (cache hit)', 'http fetch GET https://registry.npmjs.org/c attempt 1 failed with ETIMEDOUT',
        'verbose audit error FetchError: x', "verbose audit error   code: 'ECONNRESET',", "verbose audit error   type: 'system',",
        `warn audit request to ${BULK} failed, reason: socket hang up ECONNRESET`, `warn audit request to ${BULK} failed, reason: gone`,
        'error audit endpoint returned an error', 'timing command:audit Completed in 42ms', 'verbose exit 1', 'verbose code 1',
        'http fetch GET 200 https://u:p@registry.npmjs.org/x?q=1 3ms', 'http fetch GET 200 https://registry.npmjs.org/<x> 3ms', 'http fetch GET 200 ftp://x/y 3ms',
      ]],
      ['over-full', many],
      ['read from a window', many, { readWindow: 300 }],
    ]) {
      const { d, bytes } = keep(lines, limits);
      assert.deepEqual(checkDiagnosticProjection(bytes, { graph: 'application' }), { ok: true, truncated: d.truncated }, what);
    }
  });

  it('CONTRACT: printable is not sanitized — a raw npm line, a foreign graph, false counts or a stray comment are each refused', () => {
    const { bytes } = keep(HEALTHY_LOG);
    const text = bytes.toString('latin1');
    assert.equal(checkDiagnosticProjection(bytes, { graph: 'application' }).ok, true, 'premise: the original is accepted');
    for (const [what, edited] of [
      ['a raw npm line', `${text}9 verbose argv "--token=secret"\n`],
      ['an allowlisted event with free text after it', `${text}9 exit 0 token=secret\n`],
      ['a URL outside safeUrl\'s form', `${text}9 http-cache-hit https://registry.npmjs.org/x?token=abc 1ms\n`],
      ['a stray comment', `${text}# token=secret\n`],
      ['false counts', text.replace(/kept as events: (\d+)/, (_m, n) => `kept as events: ${Number(n) - 1}`)],
      ['no final newline', text.slice(0, -1)],
    ]) {
      assert.equal(checkDiagnosticProjection(Buffer.from(edited, 'latin1'), { graph: 'application' }).ok, false, what);
    }
    assert.equal(checkDiagnosticProjection(bytes, { graph: 'scanner' }).ok, false, 'another graph\'s name');
  });
});
