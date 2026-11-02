// Generates media/logo.png (128x128, Marketplace requires PNG) without dependencies, from the same geometry
// as media/logo.svg: the "P-Merge" mark (a P drawn as a merge graph) on a dark tile, rasterized with 4x4
// supersampling and encoded with node:zlib.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 128;
const SS = 4;
const BG = [20, 24, 29];
const LINE = [255, 255, 255];
const ACCENT = [46, 169, 143];

// Mark geometry in the 24-unit grid of media/mark.svg, placed on the tile like logo.svg (translate 2.2 2.4, scale .8).
const UNIT = SIZE / 24;
const toMark = (v, offset) => (v / UNIT - offset) / 0.8;
const HALF_STROKE = 0.8;
const BOWL = { cx: 13, cy: 9, r: 4.5 };
// The bowl arc stops where it meets the branch commit's outline (radius 2) and resumes after it.
const COMMIT_GAP = 2 * Math.asin(2 / (2 * BOWL.r));
const BOWL_ARCS = [
  [-Math.PI / 2, -COMMIT_GAP],
  [COMMIT_GAP, Math.PI / 2],
];

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

function distanceToArc(px, py, from, to) {
  const angle = Math.atan2(py - BOWL.cy, px - BOWL.cx);
  if (angle >= from && angle <= to) {
    return Math.abs(Math.hypot(px - BOWL.cx, py - BOWL.cy) - BOWL.r);
  }
  const end = (a) => Math.hypot(px - (BOWL.cx + BOWL.r * Math.cos(a)), py - (BOWL.cy + BOWL.r * Math.sin(a)));
  return Math.min(end(from), end(to));
}

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), SIZE - radius);
  const cy = Math.min(Math.max(y, radius), SIZE - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

function colorAt(x, y) {
  if (!insideRoundedSquare(x, y, 5 * UNIT)) {
    return null;
  }
  const mx = toMark(x, 2.2);
  const my = toMark(y, 2.4);
  if (Math.hypot(mx - 17.5, my - 9) <= 2.4 + HALF_STROKE) {
    return ACCENT; // the branch commit: the change under review
  }
  const strokes = [
    distanceToSegment(mx, my, [8, 6.5], [8, 17.5]),
    distanceToSegment(mx, my, [10, 4.5], [13, 4.5]),
    distanceToSegment(mx, my, [13, 13.5], [8, 13.5]),
    ...BOWL_ARCS.map(([from, to]) => distanceToArc(mx, my, from, to)),
    Math.abs(Math.hypot(mx - 8, my - 4.5) - 2),
    Math.abs(Math.hypot(mx - 8, my - 19.5) - 2),
  ];
  return Math.min(...strokes) <= HALF_STROKE ? LINE : BG;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = colorAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) {
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../media/logo.png', import.meta.url), png);
console.log(`media/logo.png written (${png.length} bytes)`);
