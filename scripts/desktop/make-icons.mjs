// Generates the launcher's tray PNGs (assets/desktop/) and the app icon (build/icon.ico) with Node's zlib only.
// Run: yarn icons   (the outputs are committed). Ported from api-acp-proxy/scripts/make-icons.mjs.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Renders with 4x4 supersampling; `shade(x, y)` takes unit coordinates (0..1) and returns [r,g,b,a(0..1)] or null. */
function render(size, shade) {
  const out = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const px = shade((x + (sx + 0.5) / n) / size, (y + (sy + 0.5) / n) / size);
          if (px) {
            r += px[0] * px[3];
            g += px[1] * px[3];
            b += px[2] * px[3];
            a += px[3];
          }
        }
      const i = (y * size + x) * 4,
        total = n * n;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / total) * 255);
    }
  return out;
}

function trayShade(color) {
  return (x, y) => {
    const d = Math.hypot(x - 0.5, y - 0.5);
    if (d > 0.47) return null;
    if (d > 0.37) return [255, 255, 255, 0.9]; // light ring keeps it visible on dark and light taskbars
    return [...color, 1];
  };
}

// App icon: a 16x16 pixel sprite (a dark badge with a green 7), scaled nearest-neighbour.
const SPRITE_COLORS = {
  K: [0x1a, 0x1c, 0x2c],
  D: [0x33, 0x3c, 0x57],
  G: [0x38, 0xb7, 0x64],
  W: [0xf4, 0xf4, 0xf4],
};
const SPRITE = [
  "..KKKKKKKKKKKK..",
  ".KDDDDDDDDDDDDK.",
  "KDDDDDDDDDDDDDDK",
  "KDDGGGGGGGGGGDDK",
  "KDDGGGGGGGGGGDDK",
  "KDDDDDDDDDGGGDDK",
  "KDDDDDDDDGGGDDDK",
  "KDDDDDDDGGGDDDDK",
  "KDDDDDDGGGDDDDDK",
  "KDDDDDGGGDDDDDDK",
  "KDDDDGGGDDDDDDDK",
  "KDDDDGGGDDDDDDDK",
  "KDDDDWWWDDDDDDDK",
  "KDDDDDDDDDDDDDDK",
  ".KDDDDDDDDDDDDK.",
  "..KKKKKKKKKKKK..",
];
function appShade(x, y) {
  const n = SPRITE.length;
  const color = SPRITE_COLORS[SPRITE[Math.min(n - 1, Math.floor(y * n))][Math.min(n - 1, Math.floor(x * n))]];
  return color ? [...color, 1] : null;
}

const colors = { idle: [128, 134, 145], running: [34, 197, 94], warn: [245, 158, 11], error: [239, 68, 68] };
const assets = path.join(root, "assets", "desktop");
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(path.join(root, "build"), { recursive: true });
for (const [name, color] of Object.entries(colors)) {
  fs.writeFileSync(path.join(assets, `tray-${name}.png`), png(16, render(16, trayShade(color))));
  fs.writeFileSync(path.join(assets, `tray-${name}@2x.png`), png(32, render(32, trayShade(color))));
}

// Integer multiples of the 16px sprite only, so every size stays pixel-crisp.
const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s, appShade)));
const dir = Buffer.alloc(6 + 16 * sizes.length);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);
dir.writeUInt16LE(sizes.length, 4);
let offset = dir.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  dir[e] = s === 256 ? 0 : s;
  dir[e + 1] = s === 256 ? 0 : s;
  dir[e + 2] = 0;
  dir[e + 3] = 0;
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(images[i].length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += images[i].length;
});
fs.writeFileSync(path.join(root, "build", "icon.ico"), Buffer.concat([dir, ...images]));
// The launcher window icon (BrowserWindow `icon`) is a 256px PNG next to the tray icons.
fs.writeFileSync(path.join(assets, "icon.png"), png(256, render(256, appShade)));
console.log("icons written");
