/**
 * THE HOST PROCEDURE — the script deploy.yml hands to SSM, executed as the workflow embeds
 * it, under the MODEL described in host-model.mjs (relocated paths, a curl stub for
 * Apache, a directory for the bucket, optional df/date stubs). Everything else — bash,
 * python3's tarfile, find, mv, sha256sum — is the real tool.
 *
 * The distinguishing controls run the PRE-B2.4 procedure (release/tests/baseline/
 * remote-eb54c92.sh, extracted verbatim from eb54c92's deploy.yml; a test holds it to the
 * history when the history is present) against the same host state, so each regression
 * is shown to be one the new procedure closes rather than one that never existed.
 *
 * Nothing here touches AWS, SSM, S3 or the real host. The stubs refuse anything they do
 * not recognise (exit 99), so a script change that calls a new tool fails here loudly.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { writeArchive } from '../lib/tar.mjs';
import { describeFiles, sha256Hex, walkTree } from '../lib/tree.mjs';
import { REPO_ROOT } from './fixtures.mjs';
import { hostModel, mapOwnership, remoteScriptOf, runRemote } from './host-model.mjs';
import { archiveOf, rawMember } from './tar-craft.mjs';

const SCRIPT = remoteScriptOf(readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'));
const BASELINE = readFileSync(join(REPO_ROOT, 'release/tests/baseline/remote-eb54c92.sh'), 'utf8').replace(/\n$/, '');

const SHA = 'a1'.repeat(20);
const OLD = 'b2'.repeat(20);
const LEGACY = 'c3'.repeat(20);
const future = () => String(Math.floor(Date.now() / 1000) + 3600);
const files = (obj) => new Map(Object.entries(obj).map(([p, t]) => [p, Buffer.isBuffer(t) ? t : Buffer.from(t)]));

const payloadFor = (sha, over = {}) => files({
  'index.html': '<!doctype html><html><head><script src="main-CERT0001.js" type="module"></script></head><body></body></html>\n',
  'main-CERT0001.js': 'console.log("the certified bytes");\n',
  'media/font-F0.woff2': 'woff2',
  'release.txt': `${sha}\n`,
  ...over,
});

/** The bounded values the privileged job hands the host for a CERTIFIED release. */
function certified(sha, payload, over = {}) {
  const archive = writeArchive(payload);
  const archiveSha = sha256Hex(archive);
  return {
    archive,
    tree: describeFiles(payload).treeDigest.slice('sha256:'.length),
    values: {
      TARGET_SHA: sha, MODE: 'deploy', KIND: 'certified', ARTIFACT_SHA256: archiveSha, S3_KEY: `admin/${sha}/${archiveSha}.tar.gz`,
      PAYLOAD_TREE: describeFiles(payload).treeDigest.slice('sha256:'.length), INDEX_SHA256: sha256Hex(payload.get('index.html')), DEADLINE_EPOCH: future(),
      ...over,
    },
  };
}
const legacyValues = (sha, over = {}) => ({ TARGET_SHA: sha, MODE: 'rollback', KIND: 'legacy', ARTIFACT_SHA256: '', S3_KEY: '', PAYLOAD_TREE: '', INDEX_SHA256: '', DEADLINE_EPOCH: '0', ...over });

/** A host serving a live legacy release OLD, with the admitted archive already in the bucket. */
function host({ archive, key } = {}) {
  const h = hostModel();
  h.install(OLD, files({ 'index.html': '<!doctype html><html>previous</html>\n', 'release.txt': `${OLD}\n` }));
  h.point(OLD);
  if (archive) { mkdirSync(dirname(join(h.bucket, key)), { recursive: true }); writeFileSync(join(h.bucket, key), archive); }
  return h;
}
const within = (h, fn) => { try { return fn(h); } finally { h.cleanup(); } };
const liveName = (h) => h.live().slice(h.releases.length + 1);
const treeOf = (dir) => describeFiles(walkTree(dir).files).treeDigest.slice(7);
const staging = (h) => readdirSync(h.releases).filter((n) => n.startsWith('.staging'));
const called = (h, tool) => h.calls().split('\n').some((l) => l.startsWith(`${tool} `));

describe('the baseline fixture is the pre-B2.4 procedure', () => {
  it('CONTROL: release/tests/baseline/remote-eb54c92.sh is byte-for-byte the procedure eb54c92 shipped (when history is present)', (t) => {
    const r = spawnSync('git', ['show', 'eb54c92:.github/workflows/deploy.yml'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (r.status !== 0) { t.skip('eb54c92 is not in this checkout (a shallow clone); the fixture was extracted from it and is reviewed as a file'); return; }
    assert.equal(remoteScriptOf(r.stdout), BASELINE);
  });
});

describe('the model maps ownership only where it must', () => {
  it('CONTRACT: as a non-root user, exactly the chown and the owner check are mapped in both procedures, and nothing else', () => {
    for (const script of [SCRIPT, BASELINE]) {
      const mapped = mapOwnership(script, 1001, 1002);
      assert.match(mapped, /chown -R 1001:1002 "\$\{STAGE\}\/tree"/);
      assert.match(mapped, /find "\$dir" ! -user 1001 -print -quit/);
      assert.equal(mapped.split('\n').filter((l, i) => l !== script.split('\n')[i]).length, 2);
      assert.equal(mapOwnership(script, 0, 0), script, 'as root nothing is rewritten');
    }
  });
  it('CONTRACT: a procedure whose ownership lines changed is refused by the model rather than run unmodelled', () => {
    assert.throws(() => mapOwnership(SCRIPT.replace('chown -R root:root', 'chown -R root:www-data'), 1001, 1001), /expected exactly one/);
  });
});

describe('installing a certified release', () => {
  it('CONTROL: the admitted archive is downloaded, verified member by member, installed under <sha>-<tree> and promoted', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 0, r.out);
      assert.equal(liveName(h), `${SHA}-${c.tree}`);
      assert.equal(treeOf(h.live()), c.tree);
      assert.match(r.stdout, new RegExp(`DEPLOYED-PAYLOAD: sha256:${c.tree}`));
      assert.match(r.stdout, new RegExp(`DEPLOYED-HEAD: ${SHA}`));
      assert.match(r.stdout, /PAYLOAD-VERIFIED: staged release/);
      assert.match(r.stdout, /PAYLOAD-VERIFIED: installed release/);
      assert.deepEqual(staging(h), []);
    });
  });

  it('CONTROL: an existing directory holding EXACTLY the admitted payload is reused — no download, and no disk check', () => {
    const payload = payloadFor(SHA);
    const c = certified(SHA, payload);
    within(host(), (h) => {
      h.install(`${SHA}-${c.tree}`, payload);
      h.fullDisk(0);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /RELEASE-EXISTS/);
      assert.equal(called(h, 'aws'), false);
      assert.equal(called(h, 'df'), false);
      assert.equal(liveName(h), `${SHA}-${c.tree}`);
    });
  });

  it('REGRESSION: a same-commit directory holding OTHER bytes is refused — not selected, not overwritten, not repaired', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const other = payloadFor(SHA, { 'main-CERT0001.js': 'console.log("substituted");\n' });
      const dir = h.install(`${SHA}-${c.tree}`, other);
      const before = treeOf(dir);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stderr, /never overwritten or repaired/);
      assert.equal(liveName(h), OLD, 'the live release did not move');
      assert.equal(treeOf(dir), before, 'the directory was not touched');
      assert.equal(called(h, 'aws'), false);
    });
  });

  it('DISTINGUISHING CONTROL: the pre-B2.4 procedure REUSED a same-SHA directory by release.txt alone and served substituted bytes', () => {
    within(host(), (h) => {
      h.install(SHA, payloadFor(SHA, { 'main-CERT0001.js': 'console.log("substituted");\n' }));
      const digest = 'f'.repeat(64);
      const r = runRemote(BASELINE, h, { TARGET_SHA: SHA, MODE: 'deploy', ARTIFACT_SHA256: digest, S3_KEY: `admin/${SHA}/${digest}.tar.gz` });
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /RELEASE-EXISTS/);
      assert.equal(called(h, 'aws'), false, 'the admitted artifact was never even fetched');
      assert.match(readFileSync(join(h.live(), 'main-CERT0001.js'), 'utf8'), /substituted/);
    });
  });

  it('REGRESSION: the same substituted legacy <sha> directory is ignored by a certified promotion, which installs and serves the ADMITTED bytes', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const legacy = h.install(SHA, payloadFor(SHA, { 'main-CERT0001.js': 'console.log("substituted");\n' }));
      const before = treeOf(legacy);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 0, r.out);
      assert.match(readFileSync(join(h.live(), 'main-CERT0001.js'), 'utf8'), /the certified bytes/);
      assert.equal(treeOf(legacy), before);
    });
  });

  it('REGRESSION: the downloaded archive is not the admitted one → refused before extraction', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: writeArchive(payloadFor(SHA, { 'x.js': 'other' })), key: c.values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /artifact digest mismatch/);
      assert.equal(existsSync(join(h.releases, `${SHA}-${c.tree}`)), false);
      assert.deepEqual(staging(h), []);
      assert.equal(liveName(h), OLD);
    });
  });

  it('REGRESSION: an archive whose files are not the admitted payload tree (digest consistent, contents not) → refused at staging', () => {
    const admitted = certified(SHA, payloadFor(SHA));
    const other = writeArchive(payloadFor(SHA, { 'main-CERT0001.js': 'console.log("other build of the same commit");\n' }));
    const otherSha = sha256Hex(other);
    const values = { ...admitted.values, ARTIFACT_SHA256: otherSha, S3_KEY: `admin/${SHA}/${otherSha}.tar.gz` };
    within(host({ archive: other, key: values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /staged release: .* holds payload sha256:[0-9a-f]{64}, not the admitted/);
      assert.equal(existsSync(join(h.releases, `${SHA}-${admitted.tree}`)), false);
      assert.equal(liveName(h), OLD);
    });
  });

  const hostile = {
    'a duplicate member': [rawMember('index.html', Buffer.from('<!doctype html>a')), rawMember('index.html', Buffer.from('<!doctype html>b'))],
    'a traversal': [rawMember('index.html', Buffer.from('<!doctype html>')), rawMember('../escaped.js', Buffer.from('x'))],
    'a directory member': [rawMember('media/', Buffer.alloc(0), { type: '5' }), rawMember('index.html', Buffer.from('<!doctype html>'))],
    'a symlink member': [rawMember('index.html', Buffer.from('<!doctype html>')), rawMember('evil', Buffer.alloc(0), { type: '2', linkname: '/etc/passwd' })],
    'a hardlink member': [rawMember('index.html', Buffer.from('<!doctype html>')), rawMember('evil', Buffer.alloc(0), { type: '1', linkname: 'index.html' })],
    'a pax header (renaming the next member)': [rawMember('PaxHeader', Buffer.from('16 path=evil.js\n'), { type: 'x' }), rawMember('index.html', Buffer.from('<!doctype html>'))],
    'an unreadable header': [rawMember('PaxHeader', Buffer.from('17 path=evil.js\n'), { type: 'x' }), rawMember('index.html', Buffer.from('<!doctype html>'))],
    'a file that is also a parent': [rawMember('media', Buffer.from('x')), rawMember('media/f', Buffer.from('y'))],
    'a ./-prefixed name': [rawMember('./index.html', Buffer.from('<!doctype html>'))],
  };
  for (const [label, members] of Object.entries(hostile)) {
    it(`REGRESSION MATRIX: an archive with ${label} is refused before anything is written`, () => {
      const archive = archiveOf(...members);
      const archiveSha = sha256Hex(archive);
      const c = certified(SHA, payloadFor(SHA), { ARTIFACT_SHA256: archiveSha, S3_KEY: `admin/${SHA}/${archiveSha}.tar.gz` });
      within(host({ archive, key: c.values.S3_KEY }), (h) => {
        const r = runRemote(SCRIPT, h, c.values);
        assert.equal(r.status, 1, r.out);
        assert.match(r.stderr, /DEPLOY-FAILED: the archive was refused before extraction completed/);
        assert.equal(existsSync(join(h.root, 'www', 'escaped.js')), false);
        assert.equal(existsSync(join(h.releases, `${SHA}-${c.tree}`)), false);
        assert.deepEqual(staging(h), []);
        assert.equal(liveName(h), OLD);
      });
    });
  }

  it('REGRESSION: a new install on a full disk is refused before download (the floor applies to installs only)', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      h.fullDisk(1024);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /insufficient free space/);
      assert.equal(called(h, 'aws'), false);
    });
  });
});

describe('the deadline is the host\'s to enforce', () => {
  it('REGRESSION: an assessment that stopped authorising before the procedure ran → nothing is read, written or switched', () => {
    const c = certified(SHA, payloadFor(SHA), { DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) - 5) });
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /stopped authorising promotion/);
      assert.equal(called(h, 'aws'), false);
      assert.deepEqual(h.listReleases(), [OLD]);
      assert.equal(liveName(h), OLD);
    });
  });

  it('REGRESSION: the deadline passes DURING the install (a slow SSM run) → the release is installed and verified but NOT switched to', () => {
    const deadline = 1_900_000_000;
    const c = certified(SHA, payloadFor(SHA), { DEADLINE_EPOCH: String(deadline) });
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      h.clock([deadline - 60, deadline + 1]);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1, r.out);
      assert.match(r.stdout, /RELEASE-INSTALLED/);
      assert.match(r.stderr, /nothing was switched/);
      assert.equal(liveName(h), OLD);
      assert.doesNotMatch(r.stdout, /DEPLOYED-HEAD/);
    });
  });
});

describe('rollback', () => {
  it('CONTROL: rollback to an installed CERTIFIED release re-verifies its bytes, downloads nothing and ignores a full disk', () => {
    const payload = payloadFor(SHA);
    const c = certified(SHA, payload, { MODE: 'rollback', ARTIFACT_SHA256: '', S3_KEY: '' });
    within(host(), (h) => {
      h.install(`${SHA}-${c.tree}`, payload);
      h.fullDisk(0);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /PAYLOAD-VERIFIED: existing release/);
      assert.equal(called(h, 'aws'), false);
      assert.equal(called(h, 'df'), false);
      assert.equal(liveName(h), `${SHA}-${c.tree}`);
    });
  });

  it('REGRESSION: rollback to a certified release whose bytes changed on the box → refused, live unchanged', () => {
    const c = certified(SHA, payloadFor(SHA), { MODE: 'rollback', ARTIFACT_SHA256: '', S3_KEY: '' });
    within(host(), (h) => {
      h.install(`${SHA}-${c.tree}`, payloadFor(SHA, { 'main-CERT0001.js': 'edited in place' }));
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.equal(liveName(h), OLD);
    });
  });

  it('REGRESSION: rollback never reconstructs a release that is not installed', () => {
    const c = certified(SHA, payloadFor(SHA), { MODE: 'rollback', ARTIFACT_SHA256: '', S3_KEY: '' });
    within(host({ archive: c.archive, key: `admin/${SHA}/${sha256Hex(c.archive)}.tar.gz` }), (h) => {
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not installed on this box/);
      assert.equal(called(h, 'aws'), false);
    });
  });

  it('CONTRACT: rollback to a LEGACY (pre-contract) release works exactly as before — and says it is not certified', () => {
    within(host(), (h) => {
      h.install(LEGACY, files({ 'index.html': '<!doctype html><html>legacy</html>\n', 'release.txt': `${LEGACY}\n` }));
      h.fullDisk(0);
      const r = runRemote(SCRIPT, h, legacyValues(LEGACY));
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /LEGACY: not certified, not freshly assessed/);
      assert.match(r.stdout, /DEPLOYED-KIND: legacy-unassessed/);
      assert.doesNotMatch(r.stdout, /DEPLOYED-PAYLOAD/);
      assert.equal(liveName(h), LEGACY);
      assert.equal(called(h, 'aws'), false);
    });
  });

  it('CONTROL: the baseline procedure rolled back to the same legacy release the same way', () => {
    within(host(), (h) => {
      h.install(LEGACY, files({ 'index.html': '<!doctype html><html>legacy</html>\n', 'release.txt': `${LEGACY}\n` }));
      const r = runRemote(BASELINE, h, { TARGET_SHA: LEGACY, MODE: 'rollback', ARTIFACT_SHA256: '', S3_KEY: '' });
      assert.equal(r.status, 0, r.out);
      assert.equal(liveName(h), LEGACY);
    });
  });

  it('REGRESSION: a legacy release can never be DEPLOYED, and a legacy rollback carries no payload identity', () => {
    within(host(), (h) => {
      h.install(LEGACY, files({ 'index.html': '<!doctype html>x', 'release.txt': `${LEGACY}\n` }));
      assert.match(runRemote(SCRIPT, h, legacyValues(LEGACY, { MODE: 'deploy' })).stderr, /only be rolled back to/);
      assert.match(runRemote(SCRIPT, h, legacyValues(LEGACY, { PAYLOAD_TREE: 'e'.repeat(64) })).stderr, /carries no payload identity/);
      assert.match(runRemote(SCRIPT, h, legacyValues(LEGACY, { DEADLINE_EPOCH: future() })).stderr, /carries no payload identity/);
      assert.match(runRemote(SCRIPT, h, legacyValues(LEGACY, { KIND: 'trusted' })).stderr, /KIND must be certified or legacy/);
      assert.equal(liveName(h), OLD);
    });
  });
});

describe('after the switch', () => {
  it('REGRESSION: health failing after the switch restores the previous release and still FAILS the run', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, c.values, { MODEL_HEALTH: 'degraded' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /RESTORED-PREVIOUS/);
      assert.equal(liveName(h), OLD);
      assert.doesNotMatch(r.stdout, /DEPLOYED-HEAD/);
    });
  });

  it('REGRESSION: the served entry document is not the admitted one (another build at the edge) → restored and failed', () => {
    const c = certified(SHA, payloadFor(SHA));
    within(host({ archive: c.archive, key: c.values.S3_KEY }), (h) => {
      const r = runRemote(SCRIPT, h, c.values, { MODEL_OVERRIDE_INDEX_HTML: '<!doctype html><script src="main-OTHER.js"></script>' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /\/index\.html returned HTTP 200 with sha256 [0-9a-f]{64}, expected 200 and the admitted/);
      assert.match(r.stderr, /RESTORED-PREVIOUS/);
      assert.equal(liveName(h), OLD);
    });
  });

  it('REGRESSION: an existing certified release with a group-writable file is refused (Apache must not be able to write it)', () => {
    const payload = payloadFor(SHA);
    const c = certified(SHA, payload);
    within(host(), (h) => {
      const dir = h.install(`${SHA}-${c.tree}`, payload);
      chmodSync(join(dir, 'main-CERT0001.js'), 0o664);
      const r = runRemote(SCRIPT, h, c.values);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /group- or other-writable/);
      assert.equal(liveName(h), OLD);
    });
  });
});
