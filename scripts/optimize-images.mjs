/**
 * optimize-images.mjs — downscale the shipped medallion art, losslessly and with alpha intact.
 *
 * The four PNGs in `src/assets/images/` were exported at ~1250px square, which is roughly 5x the
 * largest box any surface paints them in. They cost 8.7 MB of transfer for art that renders at
 * 17-96 CSS px, so they are resampled here, once, to the sizes the UI actually needs.
 *
 * No image library is involved on purpose: `sharp` is a native build, and this machine has neither
 * PIL nor ImageMagick. PNG is simple enough to read and write directly, and `zlib` ships with Node.
 *
 * Two details decide whether the result is usable:
 *
 * 1. **Alpha is averaged premultiplied.** A straight average of RGB across a transparent edge
 *    drags the black (or the fringe colour) of the transparent pixels into the visible rim, which
 *    is exactly the dark halo a medallion on a clay slab cannot hide. Colour is therefore weighted
 *    by coverage and divided back out after the resize.
 * 2. **Resampling is an area (box) filter, not point sampling.** At a ~4.9x reduction every source
 *    pixel covers part of a destination pixel, so the exact fractional overlap is the correct
 *    kernel — it is what a high-quality bicubic converges to under heavy downscale, without the
 *    ringing that would put a bright seam on the metal edge.
 *
 * Usage: `node scripts/optimize-images.mjs` (idempotent: a file already at its target width is
 * skipped, so a second run is a no-op rather than a second generation loss).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const IMAGES = path.resolve(here, '..', 'src', 'assets', 'images');

/** Longest edge in px, per file. 256 covers a 3x DPR badge slot; 96 is the coin that rides a CTA. */
const TARGETS = {
  'einstein.png': 256,
  'Futuristic Churchill Steel Medallion.png': 256,
  'Heisenberg Chrome Medallion.png': 256,
  'telegram_stars.png': 96,
};

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every chunk, in order. Only IHDR/IDAT matter here; the rest is carried for validation. */
function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  const out = [];
  let at = 8;
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    out.push({ type, data });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode to straight-alpha RGBA8. Only what these files actually use is supported — 8-bit,
 * non-interlaced, truecolour with or without alpha — and anything else throws rather than
 * producing a silently wrong picture.
 */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('no IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const depth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, interlace ${interlace}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[at + i];
      const a = i >= channels ? px[row + i - channels] : 0;
      const b = y > 0 ? px[prev + i] : 0;
      const c = y > 0 && i >= channels ? px[prev + i - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      px[row + i] = v & 0xff;
    }
    at += stride;
  }
  if (channels === 4) return { width, height, rgba: px };

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    rgba[i * 4] = px[j];
    rgba[i * 4 + 1] = px[j + 1];
    rgba[i * 4 + 2] = px[j + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Exact fractional coverage of source pixel `s` by destination pixel `d`, for one axis. */
function coverage(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const spans = [];
  for (let d = 0; d < dstLen; d++) {
    const from = d * scale;
    const to = from + scale;
    const list = [];
    const first = Math.floor(from);
    const last = Math.ceil(to);
    for (let s = first; s < last && s < srcLen; s++) {
      const w = Math.min(to, s + 1) - Math.max(from, s);
      if (w > 0) list.push([s, w / scale]);
    }
    spans.push(list);
  }
  return spans;
}

/**
 * Premultiplied area resample. Two separable passes keep it O(src + dst) per axis instead of
 * O(w*h) per destination pixel.
 */
function resample(img, dstW, dstH) {
  const { width: sw, height: sh, rgba } = img;
  const cols = coverage(sw, dstW);
  const rows = coverage(sh, dstH);

  /* horizontal: float RGBA, already premultiplied by its own coverage */
  const mid = new Float32Array(dstW * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sx, w] of cols[x]) {
        const o = row + sx * 4;
        const alpha = rgba[o + 3] / 255;
        const aw = alpha * w;
        r += rgba[o] * aw;
        g += rgba[o + 1] * aw;
        b += rgba[o + 2] * aw;
        a += aw;
      }
      const o = (y * dstW + x) * 4;
      mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a;
    }
  }

  /* vertical, then unpremultiply back to straight alpha */
  const out = Buffer.alloc(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [sy, w] of rows[y]) {
        const o = (sy * dstW + x) * 4;
        r += mid[o] * w;
        g += mid[o + 1] * w;
        b += mid[o + 2] * w;
        a += mid[o + 3] * w;
      }
      const o = (y * dstW + x) * 4;
      out[o + 3] = Math.round(Math.min(1, a) * 255);
      if (a > 1e-6) {
        out[o] = Math.round(Math.min(255, r / a));
        out[o + 1] = Math.round(Math.min(255, g / a));
        out[o + 2] = Math.round(Math.min(255, b / a));
      }
    }
  }
  return { width: dstW, height: dstH, rgba: out };
}

/** Standard libpng heuristic: pick the filter whose residual has the smallest absolute sum. */
function filterRow(cur, prev, stride, bpp, y) {
  const out = [];
  for (let f = 0; f < 5; f++) {
    const row = Buffer.alloc(stride);
    let sum = 0;
    for (let i = 0; i < stride; i++) {
      const x = cur[i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = y > 0 && i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x - a; break;
        case 2: v = x - b; break;
        case 3: v = x - ((a + b) >> 1); break;
        default: v = x - paeth(a, b, c); break;
      }
      row[i] = v & 0xff;
      sum += row[i] < 128 ? row[i] : 256 - row[i];
    }
    out.push({ f, row, sum });
  }
  out.sort((p, q) => p.sum - q.sum);
  return out[0];
}

function encodePng(img) {
  const { width, height, rgba } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    const { f, row } = filterRow(cur, prev, stride, 4, y);
    raw[y * (stride + 1)] = f;
    row.copy(raw, y * (stride + 1) + 1);
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour + alpha
  ihdr[10] = 0;     // deflate
  ihdr[11] = 0;     // adaptive filtering
  ihdr[12] = 0;     // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_DEFAULT_STRATEGY })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

for (const [name, longest] of Object.entries(TARGETS)) {
  const file = path.join(IMAGES, name);
  const before = fs.statSync(file).size;
  const img = decodePng(fs.readFileSync(file));
  const scale = Math.min(1, longest / Math.max(img.width, img.height));
  const dstW = Math.round(img.width * scale);
  const dstH = Math.round(img.height * scale);
  if (dstW === img.width && dstH === img.height) {
    console.log(`${name}: already ${img.width}x${img.height} — skipped`);
    continue;
  }
  const out = encodePng(resample(img, dstW, dstH));
  fs.writeFileSync(file, out);
  console.log(
    `${name}: ${img.width}x${img.height} ${kb(before)} -> ${dstW}x${dstH} ${kb(out.length)}`
    + ` (${(100 - (out.length / before) * 100).toFixed(1)}% smaller)`,
  );
}
