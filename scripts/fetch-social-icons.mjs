// Downloads brand glyphs from Simple Icons (CC0) into site/assets/img/social/ for the footer.
// Usage: node scripts/fetch-social-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
const SLUGS = ["facebook", "whatsapp", "instagram", "x", "threads", "discord", "reddit", "youtube", "telegram", "tiktok"];
await mkdir("site/assets/img/social", { recursive: true });
for (const slug of SLUGS) {
  const r = await fetch(`https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/${slug}.svg`);
  if (!r.ok) { console.log("missing", slug, r.status); continue; }
  const svg = (await r.text()).replace("<svg ", '<svg fill="currentColor" aria-hidden="true" focusable="false" ');
  await writeFile(`site/assets/img/social/${slug}.svg`, svg);
  console.log("ok", slug, svg.length);
}
