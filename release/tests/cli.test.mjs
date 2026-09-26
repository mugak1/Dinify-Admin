/**
 * The CLI's offline commands, run as processes: which certifying run a manual dispatch
 * selects, and the byte-for-byte served check — the latter against a LOCAL HTTP server
 * standing in for the origin (MODELLED; nothing here reaches admin.dinifyapp.com).
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { sha256Hex } from '../lib/tree.mjs';
import { REPO_ROOT } from './fixtures.mjs';

const CLI = join(REPO_ROOT, 'release', 'cli.mjs');
const TARGET = 'a1'.repeat(20);
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const cliAsync = (...args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args]);
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cli-')); return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; };

describe('choose-run: exactly one certifying run', () => {
  const listing = (runs) => ({ total_count: runs.length, workflow_runs: runs });
  const run = (id, over = {}) => ({ id, head_sha: TARGET, event: 'push', head_branch: 'main', conclusion: 'success', ...over });
  const choose = (value) => {
    const t = temp();
    try { writeFileSync(join(t.dir, 'runs.json'), JSON.stringify(value)); return cli('choose-run', '--target', TARGET, '--listing', join(t.dir, 'runs.json')); } finally { t.cleanup(); }
  };

  it('CONTROL: the only successful push-to-main run is chosen', () => {
    const r = choose(listing([run(11), run(12, { event: 'pull_request' }), run(13, { conclusion: 'failure' })]));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '11');
  });
  it('REGRESSION: two eligible runs (a re-run, or CI run twice) are ambiguous — the operator must name one', () => {
    const r = choose(listing([run(11), run(14)]));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /dispatch again naming ci_run_id/);
  });
  it('REGRESSION: none eligible, or a truncated listing, is not "the first one"', () => {
    assert.equal(choose(listing([run(12, { event: 'pull_request' })])).status, 1);
    assert.equal(choose({ total_count: 150, workflow_runs: [run(11)] }).status, 2);
  });
  it('CONTRACT: an explicit or event run must be a run id', () => {
    assert.equal(cli('choose-run', '--target', TARGET, '--explicit', '12; rm -rf /').status, 2);
    assert.equal(cli('choose-run', '--target', TARGET, '--event-run', '0').status, 2);
  });
  it('CONTRACT: there is no option that skips a check', () => {
    assert.equal(cli('verify', '--skip-assessment', 'yes').status, 64);
    assert.equal(cli('evaluate', '--policy', 'other.json').status, 64);
    assert.equal(cli('frobnicate').status, 64);
  });
});

describe('served: every admitted file, fetched back and compared', () => {
  const entries = { 'index.html': '<!doctype html>certified', 'main-A.js': 'certified' };
  const verified = { kind: 'certified', target: TARGET, entries: Object.entries(entries).map(([path, text]) => ({ path, sha256: sha256Hex(Buffer.from(text)) })) };
  const serve = (files, headers = { 'cache-control': 'no-store' }) => new Promise((resolve) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
      if (!(path in files)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, path === 'release.txt' ? headers : {});
      res.end(files[path]);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  const check = async (files, headers) => {
    const server = await serve(files, headers);
    const t = temp();
    try {
      writeFileSync(join(t.dir, 'verified.json'), JSON.stringify(verified));
      const r = await cliAsync('served', '--origin', `http://127.0.0.1:${server.address().port}`, '--admission', join(t.dir, 'verified.json'), '--cache-bust', 'x');
      return { ...r, out: JSON.parse(r.stdout || '{}') };
    } finally { t.cleanup(); server.close(); }
  };

  it('CONTROL: the admitted bytes, and release.txt naming the commit no-store → 0', async () => {
    const r = await check({ ...entries, 'release.txt': `${TARGET}\n` });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.matched, 2);
  });
  it('REGRESSION: the right commit serving OTHER bytes is a mismatch, never a match', async () => {
    const r = await check({ ...entries, 'main-A.js': 'another build of the same commit', 'release.txt': `${TARGET}\n` });
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.mismatched, ['main-A.js']);
  });
  it('REGRESSION: a missing file, or a cacheable release.txt, is not a match', async () => {
    assert.equal((await check({ 'index.html': entries['index.html'], 'release.txt': `${TARGET}\n` })).status, 1);
    assert.equal((await check({ ...entries, 'release.txt': `${TARGET}\n` }, { 'cache-control': 'max-age=60' })).status, 1);
  });
});
