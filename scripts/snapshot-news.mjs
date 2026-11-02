// Saves a snapshot of the live headlines (headline, outlet, link and time only: the same public data /api/news serves)
// to site/data/news-snapshot.json. scripts/build-site.mjs pre-renders it into the home page so headlines show at first
// paint, even without JavaScript; site/assets/js/news.js then replaces them with the live feed after load.
//   node scripts/snapshot-news.mjs [base]      (default https://binchika.com; run before build-site when deploying)
import { writeFile } from "node:fs/promises";
const base = (process.argv[2] ?? "https://binchika.com").replace(/\/$/, "");
const r = await fetch(`${base}/api/news`);
const j = await r.json().catch(() => ({}));
const items = (j.items ?? [])
  .filter((i) => /^https?:\/\//.test(i.link ?? "") && i.title)
  .slice(0, 8)
  .map(({ source, title, link, publishedAt }) => ({ source, title, link, publishedAt }));
if (!r.ok || !items.length) { console.log(`no snapshot written (${r.status}, ${items.length} items); the page keeps its previous snapshot`); process.exit(0); }
await writeFile("site/data/news-snapshot.json", JSON.stringify({ fetchedAt: new Date().toISOString(), items }, null, 1) + "\n");
console.log(`snapshot: ${items.length} headlines`);
