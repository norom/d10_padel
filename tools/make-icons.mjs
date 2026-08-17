/**
 * Generates the app icons.
 *
 * The icon is the scoreboard in miniature: the court split into Team A's blue
 * and Team B's green with the net between them. Full bleed, so it survives
 * Android's maskable crop.
 *
 * Run: node tools/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const COURT_A = [0x0d, 0x35, 0x57];
const COURT_B = [0x1a, 0x5c, 0x3a];
const BALL = [0xe3, 0xff, 0x4f];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

function png(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let at = 0;

  for (let y = 0; y < height; y++) {
    raw[at++] = 0; // no per-scanline filter
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      raw[at++] = r;
      raw[at++] = g;
      raw[at++] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function courtIcon(size) {
  const middle = size / 2;
  const netHalf = Math.max(1, Math.round(size * 0.016));

  return png(size, size, (x) => {
    if (Math.abs(x - middle) < netHalf) return BALL;
    return x < middle ? COURT_A : COURT_B;
  });
}

mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });

for (const size of [192, 512]) {
  const file = new URL(`../icons/icon-${size}.png`, import.meta.url);
  writeFileSync(file, courtIcon(size));
  console.log(`icons/icon-${size}.png`);
}
