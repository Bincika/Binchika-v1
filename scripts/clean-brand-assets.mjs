// Removes the baked-in checkerboard from Media/binchika_icon.png (AI export with fake transparency),
// trims, and writes web-optimised transparent icon sizes + the Oruanyi footer mark.
// Usage: node scripts/clean-brand-assets.mjs
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");

const OUT = "site/assets/img/brand";
await mkdir(OUT, { recursive: true });

async function stripChecker(src) {
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // checker squares are light-to-mid, near-neutral greys; the artwork is black, copper or saturated orange
  const bgLike = (p) => { const i = p * 4; const r = data[i], g = data[i + 1], b = data[i + 2]; return Math.max(r, g, b) - Math.min(r, g, b) < 46 && (r + g + b) / 3 > 88; };
  const bg = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (bg[p] || !bgLike(p)) continue;
    bg[p] = 1;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w);
  }
  for (let p = 0; p < w * h; p++) {
    if (bg[p]) { data[p * 4 + 3] = 0; continue; }
    // 1 px feather where artwork meets removed background
    const x = p % w, y = (p / w) | 0;
    const n = (x > 0 && bg[p - 1]) + (x < w - 1 && bg[p + 1]) + (y > 0 && bg[p - w]) + (y < h - 1 && bg[p + w]);
    if (n) data[p * 4 + 3] = Math.round(255 * (1 - n / 6));
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png();
}

const icon = await stripChecker("Media/binchika_icon.png");
const trimmed = await sharp(await icon.toBuffer()).trim({ threshold: 1 }).toBuffer();
const square = (size) => sharp(trimmed).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
// Manifest and touch icons: palette PNG (about 70% smaller; visually identical, checked 27 Oct 2026).
const ICON_PNG = { palette: true, quality: 92, effort: 10, compressionLevel: 9 };
for (const s of [1024, 512, 256, 128, 64]) {
  await square(s).png(s === 512 ? ICON_PNG : { compressionLevel: 9 }).toFile(`${OUT}/agogo-${s}.png`);
  await square(s).webp({ quality: 90, alphaQuality: 100 }).toFile(`${OUT}/agogo-${s}.webp`);
}
await square(32).png().toFile(`${OUT}/favicon-32.png`);
await square(180).flatten({ background: "#0D0E10" }).png(ICON_PNG).toFile(`${OUT}/apple-touch-icon.png`);
await square(192).png(ICON_PNG).toFile(`${OUT}/icon-192.png`);

await sharp("Media/Oru-logo-transparent.webp").resize({ height: 96 }).webp({ quality: 92, alphaQuality: 100 }).toFile(`${OUT}/oruanyi.webp`);
await sharp("Media/Oru-logo-transparent.webp").resize({ height: 96 }).png().toFile(`${OUT}/oruanyi.png`);

// QA sheet on mixed backgrounds (written to the path given as argv[2], e.g. the scratchpad)
if (process.argv[2]) {
  const tile = await square(300).png().toBuffer();
  await sharp({ create: { width: 920, height: 320, channels: 4, background: "#ffffff" } })
    .composite([
      { input: { create: { width: 300, height: 300, channels: 4, background: "#0A0B0D" } }, left: 10, top: 10 },
      { input: { create: { width: 300, height: 300, channels: 4, background: "#F6F5F1" } }, left: 310, top: 10 },
      { input: { create: { width: 300, height: 300, channels: 4, background: "#1559D6" } }, left: 610, top: 10 },
      { input: tile, left: 10, top: 10 }, { input: tile, left: 310, top: 10 }, { input: tile, left: 610, top: 10 },
    ]).png().toFile(process.argv[2]);
}
console.log("brand assets written to", OUT);
