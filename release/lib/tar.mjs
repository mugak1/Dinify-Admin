/**
 * THE PAYLOAD ARCHIVE — one canonical form, written here and read back strictly.
 *
 * The payload crosses from certification to S3 to the host as a gzip-compressed POSIX
 * ustar archive. There is exactly ONE archive this module will produce for a set of files,
 * and the reader accepts exactly that one:
 *
 *   - regular files only (typeflag '0'); no directory, link, device, FIFO, pax or GNU
 *     extension record — parent directories are implied by the paths;
 *   - entries in path order; every path canonical (tree.mjs → pathProblem), unique, and
 *     never both a file and the parent of another file;
 *   - fixed metadata: mode 0644, uid/gid 0, empty user and group names, mtime
 *     2020-01-01T00:00:00Z — the host re-owns and re-modes everything anyway, and a
 *     varying header would make identical files produce different archives;
 *   - two zero blocks and nothing after them.
 *
 * THE READER REFUSES RATHER THAN FILTERS. It extracts the files and then REBUILDS the
 * canonical tar stream from them; if the bytes it was given are not byte-for-byte that
 * stream, the archive is refused. So an extra member, a symlink, a traversal, a duplicate
 * name, a pax header, a different mode, trailing data or an unusual padding all fail the
 * same way — nothing is dropped on the floor and the rest accepted.
 *
 * The gzip layer is not canonicalised (zlib versions may compress differently); the
 * archive's own sha256 is what S3 and the host bind, and the tree digest is what the
 * release IS. Pure: bytes in, bytes out.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

import { pathProblem, prefixConflicts } from './tree.mjs';

const BLOCK = 512;
export const FIXED_MTIME = 1577836800; // 2020-01-01T00:00:00Z
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 10000;

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`;

function splitName(path) {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(name, 'utf8') <= 100) return { name, prefix };
  }
  throw new TypeError(`${path} cannot be expressed in a ustar header`);
}

function header(path, size) {
  const h = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitName(path);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  h.fill(0x20, 148, 156); // the checksum is computed with its own field as spaces
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(octal(0, 8), 329, 8, 'ascii');
  h.write(octal(0, 8), 337, 8, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

function validateSet(paths) {
  const problems = [];
  const seen = new Set();
  for (const p of paths) {
    const why = pathProblem(p);
    if (why) problems.push(`${JSON.stringify(p)}: ${why}`);
    if (seen.has(p)) problems.push(`${p} appears twice`);
    seen.add(p);
  }
  problems.push(...prefixConflicts([...seen]));
  if (paths.length === 0) problems.push('no files');
  if (paths.length > MAX_ENTRIES) problems.push(`more than ${MAX_ENTRIES} files`);
  return problems;
}

/** The canonical uncompressed tar stream for a Map<path, Buffer>. Throws on an invalid set. */
export function tarStream(files) {
  const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const problems = validateSet(paths);
  if (problems.length) throw new TypeError(`not a payload: ${problems.join('; ')}`);
  const parts = [];
  for (const path of paths) {
    const bytes = files.get(path);
    if (!Buffer.isBuffer(bytes)) throw new TypeError(`${path} has no bytes`);
    if (bytes.length > MAX_FILE_BYTES) throw new TypeError(`${path} is larger than ${MAX_FILE_BYTES} bytes`);
    parts.push(header(path, bytes.length), bytes);
    const pad = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** The payload archive: the canonical tar stream, gzip-compressed with a zero mtime. */
export function writeArchive(files) {
  return gzipSync(tarStream(files), { level: 9 });
}

const field = (buf, start, length) => {
  const raw = buf.subarray(start, start + length);
  const end = raw.indexOf(0);
  return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
};

/**
 * Read a payload archive. Returns {files: Map<path, Buffer>, problems}. `problems` empty
 * means the archive is exactly the canonical archive of `files`.
 */
export function readArchive(archive) {
  const fail = (...problems) => ({ files: new Map(), problems });
  if (!Buffer.isBuffer(archive) || archive.length === 0) return fail('the archive is empty');
  if (archive.length > MAX_ARCHIVE_BYTES) return fail(`the archive is larger than ${MAX_ARCHIVE_BYTES} bytes`);
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: MAX_ARCHIVE_BYTES }); } catch (error) {
    return fail(`the archive is not readable gzip (${error.code ?? error.message})`);
  }
  if (tar.length % BLOCK !== 0) return fail('the tar stream is not a whole number of blocks');
  const files = new Map();
  const order = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const h = tar.subarray(offset, offset + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (order.length >= MAX_ENTRIES) return fail(`more than ${MAX_ENTRIES} members`);
    const type = String.fromCharCode(h[156]);
    const name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    if (type !== '0') return fail(`member ${JSON.stringify(path)} has type ${JSON.stringify(type)}; only regular files are accepted`);
    const sizeText = field(h, 124, 12).trim();
    if (!/^[0-7]{1,11}$/.test(sizeText)) return fail(`member ${JSON.stringify(path)} has an unreadable size`);
    const size = parseInt(sizeText, 8);
    if (size > MAX_FILE_BYTES) return fail(`member ${JSON.stringify(path)} is larger than ${MAX_FILE_BYTES} bytes`);
    const start = offset + BLOCK;
    if (start + size > tar.length) return fail(`member ${JSON.stringify(path)} is truncated`);
    if (files.has(path)) return fail(`${path} appears twice`);
    const why = pathProblem(path);
    if (why) return fail(`member ${JSON.stringify(path)}: ${why}`);
    files.set(path, Buffer.from(tar.subarray(start, start + size)));
    order.push(path);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  const problems = validateSet(order);
  if (problems.length) return fail(...problems);
  let canonical;
  try { canonical = tarStream(files); } catch (error) { return fail(error.message); }
  if (!canonical.equals(tar)) {
    return fail('the archive is not in canonical form (member order, header metadata, padding or trailing data differ from the one archive these files have)');
  }
  return { files, problems: [] };
}
