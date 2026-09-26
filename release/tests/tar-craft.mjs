/**
 * Hand-made tar members, for archives the canonical writer never produces: links,
 * directories, pax headers, traversals, duplicates. Used by the reader's matrix and by
 * the host procedure's extraction matrix.
 */

import { gzipSync } from 'node:zlib';

/** Write one raw ustar header + body for crafting archives the canonical writer never makes. */
export function rawMember(name, body, { type = '0', mode = 0o644, linkname = '', prefix = '' } = {}) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100);
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${(1577836800).toString(8).padStart(11, '0')}\0`, 136);
  h.fill(0x20, 148, 156);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257); h.write('00', 263);
  h.write('0000000\0', 329); h.write('0000000\0', 337);
  h.write(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([h, body, pad]);
}
export const archiveOf = (...members) => gzipSync(Buffer.concat([...members, Buffer.alloc(1024, 0)]));
