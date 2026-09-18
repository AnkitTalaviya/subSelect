/**
 * Generates the extension PNG icons with no image dependencies.
 *
 * The mark is a subtitle block with one word highlighted — the product in one glyph.
 * Drawn at 4x and box-downsampled for antialiasing, then encoded as a minimal PNG
 * (IHDR / IDAT / IEND, colour type 6, 8-bit RGBA) using node:zlib.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = resolve(ROOT, 'public/icons');
const STORE_DIR = resolve(ROOT, 'store');
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling factor

const BG = [0x14, 0x16, 0x20];
const BAR = [0xe8, 0xea, 0xf2];
const ACCENT = [0x6c, 0x8c, 0xff];

// ── PNG encoding ──────────────────────────────────────────────────────────────

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

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12: compression, filter, interlace — all 0

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** Rounded-rectangle coverage test in supersampled space. */
function inRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * `pad` insets the whole mark by that many design units on every side. The toolbar icons
 * want the full frame; the Chrome Web Store listing icon is specified as a 96x96 mark
 * centred on a 128x128 canvas, which is `pad: 16`.
 */
function renderIcon(size, { pad = 0 } = {}) {
  const big = size * SS;
  const hi = new Uint8Array(big * big * 4);
  const u = big / 128; // design units: everything below is authored at 128px
  const scale = (128 - 2 * pad) / 128;

  /** Shapes are painted back to front; last writer wins. */
  const shapes = [
    { x: 4, y: 4, w: 120, h: 120, r: 28, color: BG },
    // caption line 1, with the third "word" highlighted
    { x: 22, y: 52, w: 26, h: 12, r: 6, color: BAR },
    { x: 54, y: 52, w: 16, h: 12, r: 6, color: BAR },
    { x: 76, y: 48, w: 30, h: 20, r: 8, color: ACCENT },
    // caption line 2
    { x: 22, y: 78, w: 38, h: 12, r: 6, color: BAR },
    { x: 66, y: 78, w: 22, h: 12, r: 6, color: BAR },
  ];

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      let painted = null;
      for (const s of shapes) {
        const inset = (v) => (pad + v * scale) * u;
        if (inRoundedRect(x, y, inset(s.x), inset(s.y), s.w * scale * u, s.h * scale * u, s.r * scale * u)) {
          painted = s.color;
        }
      }
      const i = (y * big + x) * 4;
      if (painted) {
        hi[i] = painted[0];
        hi[i + 1] = painted[1];
        hi[i + 2] = painted[2];
        hi[i + 3] = 255;
      }
    }
  }

  // Box downsample with premultiplied alpha so edges stay clean.
  const out = Buffer.alloc(size * size * 4);
  const n = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const av = hi[i + 3] / 255;
          r += hi[i] * av;
          g += hi[i + 1] * av;
          b += hi[i + 2] * av;
          a += av;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(resolve(OUT_DIR, `icon-${size}.png`), encodePng(size, renderIcon(size)));
}

// The listing icon is a separate asset: same mark, the store's padding.
mkdirSync(STORE_DIR, { recursive: true });
writeFileSync(resolve(STORE_DIR, 'store-icon-128.png'), encodePng(128, renderIcon(128, { pad: 16 })));

console.log(`SubSelect: wrote ${SIZES.length} icons to public/icons/ and the store icon to store/`);
