/**
 * Packages dist/ into a loadable / uploadable zip, with no dependencies.
 *
 * Windows PowerShell 5.1's Compress-Archive writes `\` path separators, which the ZIP
 * spec (APPNOTE 4.4.17) forbids — a strict reader then sees one file named
 * "icons\icon-128.png" at the root and every path in manifest.json dangles. So the
 * archive is written here instead, with forward slashes and deflate compression.
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(root, 'dist');

const { name, version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const outPath = resolve(root, `${name}-${version}.zip`);

// ── CRC-32 ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── ZIP writing ───────────────────────────────────────────────────────────────

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const files = walk(distDir).sort();
if (files.length === 0) throw new Error('dist/ is empty — run `npm run build` first');

const UTF8_FLAG = 0x0800;
const locals = [];
const centrals = [];
let offset = 0;

for (const file of files) {
  // Forward slashes, always — this is the whole point of the script.
  const zipName = relative(distDir, file).split(sep).join('/');
  const raw = readFileSync(file);
  const deflated = deflateRawSync(raw, { level: 9 });

  // Never let "compression" grow a file: fall back to stored.
  const stored = deflated.length >= raw.length;
  const body = stored ? raw : deflated;
  const method = stored ? 0 : 8;

  const nameBuf = Buffer.from(zipName, 'utf8');
  const { time, date } = dosDateTime(statSync(file).mtime);
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_FLAG, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  locals.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by: MS-DOS, 2.0
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_FLAG, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 30); // extra + comment lengths
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(offset, 42);

  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}

const centralDirectory = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralDirectory.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

writeFileSync(outPath, Buffer.concat([...locals, centralDirectory, eocd]));

const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(`SubSelect: packaged ${files.length} files (${total} B raw) → ${relative(root, outPath)}`);
