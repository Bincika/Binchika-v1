// Downloads official party logos published on inecnigeria.org, keeps the raw files in data/raw/inec/logos,
// and writes cleaned web versions (white background removed from the edges, trimmed, 256px WebP + PNG)
// to site/assets/img/parties/. Logos are party marks, shown only for neutral identification.
// Usage: node scripts/fetch-party-logos.mjs
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");

const BASE = "https://inecnigeria.org";
const UA = { headers: { "user-agent": "BinchikaDataBuild/1.0 (+https://binchika.com; ops@binchika.com)" } };
const RAW = "data/raw/inec/logos";
const OUT = "site/assets/img/parties";
await mkdir(RAW, { recursive: true });
await mkdir(OUT, { recursive: true });

// 1. discover logo asset names across the page and every Nuxt chunk it references
const found = new Map();
const scan = (text) => { for (const m of text.matchAll(/([a-z0-9-]+_logo\.[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|svg))/g)) found.set(m[1].split("_logo")[0], m[1]); };
const seen = new Set();
const queue = ["/political-parties/", "/parties"];
while (queue.length) {
  const p = queue.shift();
  if (seen.has(p)) continue;
  seen.add(p);
  let t = "";
  try { t = await (await fetch(BASE + p, UA)).text(); } catch { continue; }
  scan(t);
  for (const m of t.matchAll(/\/?_nuxt\/[A-Za-z0-9._-]+\.js/g)) { const js = "/" + m[0].replace(/^\//, ""); if (!seen.has(js) && seen.size < 400) queue.push(js); }
}
found.delete("inec_brand");
console.log("chunks scanned:", seen.size, "logos found:", found.size);

// 2. match to the register by acronym in the slug
const parties = JSON.parse(await readFile("site/data/parties.json", "utf8")).parties;
const SLUG_HINT = { NDP: "national-democratic-party", NDC: "nigeria-democratic-congress", A: "accord" };
const manifest = {};
for (const p of parties) {
  const slug = [...found.keys()].find((k) => (SLUG_HINT[p.acronym] ? k.startsWith(SLUG_HINT[p.acronym]) : k.endsWith("-" + p.acronym.toLowerCase())));
  if (!slug) { manifest[p.acronym] = null; console.log("missing", p.acronym); continue; }
  const file = found.get(slug);
  const buf = Buffer.from(await (await fetch(`${BASE}/_nuxt/${file}`, UA)).arrayBuffer());
  await writeFile(`${RAW}/${file}`, buf);

  // 3. clean: flood-fill near-white from the borders to transparent, then trim and resize
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const isBg = (i) => data[i] > 232 && data[i + 1] > 232 && data[i + 2] > 232;
  const stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  const done = new Uint8Array(w * h);
  while (stack.length) {
    const px = stack.pop();
    if (done[px]) continue;
    done[px] = 1;
    const i = px * 4;
    if (!isBg(i)) continue;
    data[i + 3] = 0;
    const x = px % w, y = (px / w) | 0;
    if (x > 0) stack.push(px - 1); if (x < w - 1) stack.push(px + 1);
    if (y > 0) stack.push(px - w); if (y < h - 1) stack.push(px + w);
  }
  const clean = sharp(data, { raw: { width: w, height: h, channels: 4 } }).trim({ threshold: 1 }).resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const key = p.acronym.toLowerCase();
  await clean.clone().webp({ quality: 90, alphaQuality: 100 }).toFile(`${OUT}/${key}.webp`);
  await clean.clone().png({ compressionLevel: 9 }).toFile(`${OUT}/${key}.png`);
  manifest[p.acronym] = { webp: `/assets/img/parties/${key}.webp`, png: `/assets/img/parties/${key}.png`, source: `${BASE}/_nuxt/${file}`, fetchedAt: new Date().toISOString() };
  console.log("ok", p.acronym, file);
}
await writeFile("site/data/party-logos.json", JSON.stringify({ source: "INEC (inecnigeria.org) party register assets", manifest }, null, 2));
console.log("with logo:", Object.values(manifest).filter(Boolean).length, "/", parties.length);
