/**
 * FILE-TREE IDENTITY — what a release IS, independently of how it travels.
 *
 * Three different identities exist for one Admin release, and they are deliberately
 * never confused (release/README.md → "Three identities"):
 *
 *   payload tree digest   THIS FILE. A digest over the files the host serves — path and
 *                         content, nothing else. It names the release directory on the
 *                         box, and the host recomputes it from the installed bytes before
 *                         it promotes anything (install, reuse and rollback alike).
 *   payload archive sha256 the transport of those files to S3 and the host (tar.mjs).
 *   artifact digest       GitHub's digest of the zip that carries the candidate between
 *                         runs (checked by actions/download-artifact and the API).
 *
 * THE COMPOSITION IS DINIFY-FRONTEND'S (`release/lib/canonical.mjs → treeDigest`), byte
 * for byte: entries sorted by path, each line `<utf8 length>:<path>\0<sha256 hex>\n`,
 * the digest `sha256:<hex>` of the concatenation. A pinned vector in the tests holds the
 * two equal, so "tree digest" means one thing across the Dinify release records. The
 * host computes the same composition in Python (deploy.yml); a test holds that equal too.
 *
 * NAMES ARE RESTRICTED, not escaped. A payload path is one or more components drawn from
 * [A-Za-z0-9._@+~-], none of them `.` or `..`, separated by `/`. Everything Angular emits
 * fits, the sort order of such names is the same in every language that computes this
 * digest (JavaScript code units, Python code points, bytes), and a name that could be
 * read two ways — a backslash, a NUL, `a//b`, `./a` — is refused rather than normalised.
 *
 * Pure except walkTree, which reads a directory; nothing here follows a symbolic link.
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const digestOf = (bytes) => `sha256:${sha256Hex(bytes)}`;

const COMPONENT = /^[A-Za-z0-9._@+~-]+$/;
export const MAX_PATH_BYTES = 240;

/** Null when `path` is a canonical payload path, otherwise why it is not. */
export function pathProblem(path) {
  if (typeof path !== 'string' || path.length === 0) return 'empty path';
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `path longer than ${MAX_PATH_BYTES} bytes`;
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '') return 'empty component (a leading, trailing or doubled slash)';
    if (part === '.' || part === '..') return `"${part}" component`;
    if (!COMPONENT.test(part)) return 'a character outside [A-Za-z0-9._@+~-]';
  }
  return null;
}

/** ASCII-only names make every sort agree; this is the one the digest uses. */
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The tree digest of [{path, sha256}]. Throws on an entry that cannot be part of a
 * payload — a caller that reaches here with one has already failed to validate.
 */
export function treeDigest(entries) {
  const seen = new Set();
  const lines = [];
  for (const entry of [...entries].sort(byPath)) {
    const problem = pathProblem(entry.path);
    if (problem) throw new TypeError(`tree entry ${JSON.stringify(entry.path)}: ${problem}`);
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) throw new TypeError(`tree entry ${entry.path} has no sha256`);
    if (seen.has(entry.path)) throw new TypeError(`duplicate tree entry ${entry.path}`);
    seen.add(entry.path);
    lines.push(`${Buffer.byteLength(entry.path, 'utf8')}:${entry.path}\0${entry.sha256}\n`);
  }
  if (lines.length === 0) throw new TypeError('an empty tree has no digest');
  return digestOf(Buffer.from(lines.join(''), 'utf8'));
}

/**
 * A path that is both a file and the parent of another file cannot exist on disk, and an
 * archive that says so is ambiguous about which one it means. Returns the conflicts.
 */
export function prefixConflicts(paths) {
  const files = new Set(paths);
  const out = [];
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (files.has(parent)) out.push(`${parent} is a file and the parent of ${p}`);
    }
  }
  return out;
}

/** Entries of an in-memory file map, with the tree facts the records carry. */
export function describeFiles(files) {
  const entries = [...files.entries()]
    .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), bytes: bytes.length }))
    .sort(byPath);
  return {
    entries,
    treeDigest: treeDigest(entries),
    entryCount: entries.length,
    bytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}

/**
 * Every regular file under `root`, as Map<path, Buffer>, or the reasons it is not a
 * payload. Symbolic links, sockets, devices and FIFOs are REFUSED (never followed,
 * never skipped); so is a name that is not a canonical payload path, an unreadable
 * entry, and an empty tree. Directories contribute nothing but their files.
 */
export function walkTree(root, { maxFiles = 10000 } = {}) {
  const files = new Map();
  const problems = [];
  let rootStat;
  try { rootStat = lstatSync(root); } catch (error) {
    return { files, problems: [`${root}: ${error.code ?? error.message}`] };
  }
  if (!rootStat.isDirectory()) return { files, problems: [`${root} is not a directory`] };
  const visit = (dir, prefix) => {
    let names;
    try { names = readdirSync(dir).sort(); } catch (error) { problems.push(`${prefix || '.'}: cannot be listed (${error.code ?? error.message})`); return; }
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      let st;
      try { st = lstatSync(full); } catch (error) { problems.push(`${rel}: ${error.code ?? error.message}`); continue; }
      if (st.isSymbolicLink()) { problems.push(`${rel} is a symbolic link`); continue; }
      if (st.isDirectory()) {
        const p = pathProblem(rel);
        if (p) { problems.push(`${rel}: ${p}`); continue; }
        visit(full, rel);
        continue;
      }
      if (!st.isFile()) { problems.push(`${rel} is neither a regular file nor a directory`); continue; }
      const p = pathProblem(rel);
      if (p) { problems.push(`${rel}: ${p}`); continue; }
      if (files.size >= maxFiles) { problems.push(`more than ${maxFiles} files`); return; }
      try { files.set(rel, readFileSync(full)); } catch (error) { problems.push(`${rel}: cannot be read (${error.code ?? error.message})`); }
    }
  };
  visit(root, '');
  if (files.size === 0 && problems.length === 0) problems.push(`${root} holds no files`);
  return { files, problems };
}
