/**
 * THE PAYLOAD'S IDENTITY AND ITS TRANSPORT.
 *
 * The tree digest is computed by THREE implementations that must agree: this repository's
 * Node (release/lib/tree.mjs), the Python the host runs (embedded in deploy.yml — extracted
 * and executed here, not restated), and Dinify-Frontend's release/lib/canonical.mjs (held
 * by a vector computed with that function). The archive reader must refuse — not filter —
 * every member shape the canonical writer never produces.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { readArchive, tarStream, writeArchive } from '../lib/tar.mjs';
import { describeFiles, pathProblem, sha256Hex, treeDigest, walkTree } from '../lib/tree.mjs';
import { REPO_ROOT, tempDir } from './fixtures.mjs';
import { remoteScriptOf, remoteTreeDigestProgram } from './host-model.mjs';
import { archiveOf, rawMember } from './tar-craft.mjs';

const DEPLOY = readFileSync(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
const files = (obj) => new Map(Object.entries(obj).map(([p, t]) => [p, Buffer.from(t)]));

describe('the payload tree digest', () => {
  it('CONTRACT: the composition is Dinify-Frontend\'s treeDigest, byte for byte (vector computed with release/lib/canonical.mjs at 4ce0183)', () => {
    const vector = { 'index.html': '<!doctype html>', 'release.txt': 'abc\n', 'media/a.woff2': 'x', 'b/c.js': 'y' };
    assert.equal(describeFiles(files(vector)).treeDigest, 'sha256:a9b2cfd3339ab535d41b8ca0f6951ab3c8bb1ccd86dc1b798e0bc6106fb0268e');
  });

  it('CONTRACT: the host\'s Python (as deploy.yml embeds it) computes the same digest from the installed files', () => {
    const t = tempDir();
    try {
      const f = files({ 'index.html': '<!doctype html>\n', 'release.txt': `${'a'.repeat(40)}\n`, 'media/font-X.woff2': 'woff', 'chunk-Z.js': 'z', '3rdpartylicenses.txt': 'mit', 'a/b/c@d+e~f-g.js': 'deep' });
      for (const [p, b] of f) { mkdirSync(join(t.dir, p, '..'), { recursive: true }); writeFileSync(join(t.dir, p), b); }
      const program = remoteTreeDigestProgram(remoteScriptOf(DEPLOY));
      const r = spawnSync('python3', ['-', t.dir], { input: program, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(`sha256:${r.stdout.trim()}`, describeFiles(f).treeDigest);
      assert.equal(`sha256:${r.stdout.trim()}`, describeFiles(walkTree(t.dir).files).treeDigest);
    } finally { t.cleanup(); }
  });

  it('REGRESSION MATRIX: the host\'s Python refuses a symlink, a special name and an empty tree instead of skipping them', () => {
    const program = remoteTreeDigestProgram(remoteScriptOf(DEPLOY));
    for (const [label, setup] of [
      ['a symlinked file', (d) => { writeFileSync(join(d, 'index.html'), 'x'); symlinkSync('/etc/hostname', join(d, 'link.js')); }],
      ['a symlinked directory', (d) => { writeFileSync(join(d, 'index.html'), 'x'); symlinkSync('/etc', join(d, 'etc')); }],
      ['a name with a space', (d) => { writeFileSync(join(d, 'bad name.js'), 'x'); }],
      ['an empty tree', () => {}],
    ]) {
      const t = tempDir();
      try {
        setup(t.dir);
        const r = spawnSync('python3', ['-', t.dir], { input: program, encoding: 'utf8' });
        assert.notEqual(r.status, 0, label);
      } finally { t.cleanup(); }
    }
  });

  it('REGRESSION MATRIX: a non-canonical or ambiguous name is refused, never normalised', () => {
    for (const bad of ['', '/abs', 'a//b', './a', 'a/./b', '../a', 'a/..', 'a\\b', 'a b', 'é.js', `${'x'.repeat(241)}`, 'a\0b']) {
      assert.ok(pathProblem(bad), JSON.stringify(bad));
    }
    for (const good of ['index.html', 'media/x-Y_z.woff2', '3rdpartylicenses.txt', 'a/b/c@d+e~f-g.js']) assert.equal(pathProblem(good), null, good);
    assert.throws(() => treeDigest([{ path: 'a', sha256: sha256Hex('x') }, { path: 'a', sha256: sha256Hex('y') }]), /duplicate/);
  });

  it('REGRESSION MATRIX: walkTree refuses a symlink rather than following or skipping it', () => {
    const t = tempDir();
    try {
      writeFileSync(join(t.dir, 'index.html'), 'x');
      symlinkSync('/etc/passwd', join(t.dir, 'passwd'));
      const w = walkTree(t.dir);
      assert.ok(w.problems.some((p) => /symbolic link/.test(p)));
    } finally { t.cleanup(); }
  });
});

describe('the payload archive', () => {
  const payload = files({ 'index.html': '<!doctype html>\n', 'release.txt': 'x\n', 'media/f.woff2': 'w' });

  it('CONTROL: the canonical archive round-trips to exactly its files and its tree', () => {
    const r = readArchive(writeArchive(payload));
    assert.deepEqual(r.problems, []);
    assert.equal(describeFiles(r.files).treeDigest, describeFiles(payload).treeDigest);
  });

  it('CONTROL: identical files produce an identical archive (the transport digest is reproducible)', () => {
    assert.equal(sha256Hex(writeArchive(payload)), sha256Hex(writeArchive(new Map([...payload].reverse()))));
  });

  it('CONTROL: Python\'s tarfile reads the canonical archive as regular files with no pax metadata', () => {
    const t = tempDir();
    try {
      writeFileSync(join(t.dir, 'a.tar.gz'), writeArchive(payload));
      const r = spawnSync('python3', ['-c', 'import sys,tarfile\nt=tarfile.open(sys.argv[1],"r:gz")\nprint(sorted((m.name,m.type==tarfile.REGTYPE,bool(m.pax_headers)) for m in t.getmembers()))', join(t.dir, 'a.tar.gz')], { encoding: 'utf8' });
      assert.equal(r.stdout.trim(), "[('index.html', True, False), ('media/f.woff2', True, False), ('release.txt', True, False)]");
    } finally { t.cleanup(); }
  });

  const refusals = {
    'a symlink member': archiveOf(rawMember('index.html', Buffer.from('x')), rawMember('evil', Buffer.alloc(0), { type: '2', linkname: '/etc/passwd' })),
    'a hardlink member': archiveOf(rawMember('index.html', Buffer.from('x')), rawMember('evil', Buffer.alloc(0), { type: '1', linkname: 'index.html' })),
    'a directory member': archiveOf(rawMember('media/', Buffer.alloc(0), { type: '5' }), rawMember('media/f', Buffer.from('x'))),
    'a pax header': archiveOf(rawMember('PaxHeader', Buffer.from('17 path=evil.js\n'), { type: 'x' }), rawMember('index.html', Buffer.from('x'))),
    'a traversal': archiveOf(rawMember('../escape.js', Buffer.from('x'))),
    'an absolute path': archiveOf(rawMember('/etc/cron.d/x', Buffer.from('x'))),
    'a duplicate name': archiveOf(rawMember('index.html', Buffer.from('a')), rawMember('index.html', Buffer.from('b'))),
    'a ./-prefixed name (ambiguous with its canonical form)': archiveOf(rawMember('./index.html', Buffer.from('x'))),
    'a file that is also a parent': archiveOf(rawMember('media', Buffer.from('x')), rawMember('media/f', Buffer.from('y'))),
    'a non-canonical mode': archiveOf(rawMember('index.html', Buffer.from('x'), { mode: 0o4755 })),
    'members out of order': archiveOf(rawMember('z.js', Buffer.from('x')), rawMember('a.js', Buffer.from('y'))),
    'trailing data after the end': gzipSync(Buffer.concat([tarStream(payload), Buffer.from('trailing')])),
    'not gzip at all': Buffer.from('plain text'),
  };
  for (const [label, bytes] of Object.entries(refusals)) {
    it(`REGRESSION MATRIX: ${label} is refused — the archive is not partially accepted`, () => {
      const r = readArchive(bytes);
      assert.ok(r.problems.length > 0, label);
      assert.equal(r.files.size, 0);
    });
  }
});
