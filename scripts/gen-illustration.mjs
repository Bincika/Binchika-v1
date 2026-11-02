// Generates the /vote/ "not for sale" illustration once, then self-hosts it (no third-party image at runtime).
// The raw generation is kept untouched in data/raw/art/ (provenance); sharp makes the web sizes in site/assets/img/art/.
// Uses OPENAI_API_KEY from the environment (never printed). The prompt has no personal data: hands and generic notes
// only, no faces, no party colours, logos or real currency designs. The red "not for sale" mark is drawn in HTML/CSS.
//   node scripts/gen-illustration.mjs            generate + convert
//   node scripts/gen-illustration.mjs --convert  re-convert the kept raw file only
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import sharp from "sharp";

const MODEL = process.env.IMAGE_MODEL ?? "gpt-image-2";
const RAW = "data/raw/art/vote-not-for-sale.png";
const OUT = "site/assets/img/art";
const PROMPT = [
  "Documentary photograph, tight close-up of two adult hands across a weathered wooden table in warm late-afternoon light.",
  "One hand, in a plain grey cotton sleeve, slides forward a folded bundle of plain generic paper banknotes held by a rubber band;",
  "the other hand, in a plain cream sleeve, hesitates mid-reach with fingers half open, not yet touching the money.",
  "The banknotes are plain and generic: no legible text, no portraits, no numbers, no national emblems.",
  "Background: soft out-of-focus outdoor community space with blurred plastic chairs and warm dust in the air; no people, no faces,",
  "no flags, no posters, no party colours, no logos, no writing anywhere.",
  "Shallow depth of field isolating the hands and the bundle, subject in the right two-thirds, darker empty space on the left third.",
  "56mm lens at f/1.4, low sun from camera-right, long soft shadows, muted earthy palette, slightly underexposed. No text in the image.",
].join(" ");

if (!process.argv.includes("--convert")) {
  if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY is not set"); process.exit(1); }
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, prompt: PROMPT, size: "1536x1024", quality: "high", n: 1 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.data?.[0]?.b64_json) { console.error("generation failed:", r.status, j.error?.message ?? ""); process.exit(1); }
  mkdirSync("data/raw/art", { recursive: true });
  writeFileSync(RAW, Buffer.from(j.data[0].b64_json, "base64"));
  writeFileSync(RAW.replace(/\.png$/, ".json"), JSON.stringify({ model: MODEL, size: "1536x1024", generated: new Date().toISOString(), prompt: PROMPT }, null, 2) + "\n");
  console.log("raw image saved:", RAW);
}
if (!existsSync(RAW)) { console.error("no raw image to convert"); process.exit(1); }
mkdirSync(OUT, { recursive: true });
for (const w of [1536, 768]) {
  await sharp(RAW).resize({ width: w }).webp({ quality: 74 }).toFile(`${OUT}/vote-not-for-sale-${w}.webp`);
}
await sharp(RAW).resize({ width: 1024 }).jpeg({ quality: 72, mozjpeg: true }).toFile(`${OUT}/vote-not-for-sale-1024.jpg`);
for (const f of ["1536.webp", "768.webp", "1024.jpg"]) {
  const m = await sharp(`${OUT}/vote-not-for-sale-${f}`).metadata();
  console.log(`${OUT}/vote-not-for-sale-${f}: ${m.width}×${m.height}, ${Math.round((await import("node:fs")).statSync(`${OUT}/vote-not-for-sale-${f}`).size / 1024)} KB`);
}
