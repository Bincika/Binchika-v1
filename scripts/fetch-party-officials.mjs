// Party officials from each party's INEC profile page (inecnigeria.org/parties/<slug>), plus social handles
// ONLY when verifiable through a chain: INEC lists the party's official website → that website links the handle.
// Writes site/data/party-officials.json (every field with source URL + fetch time). Usage: node scripts/fetch-party-officials.mjs
import { readFile, writeFile } from "node:fs/promises";

const UA = { headers: { "user-agent": "BinchikaDataBuild/1.0 (+https://binchika.com)" } };
const logos = JSON.parse(await readFile("site/data/party-logos.json", "utf8")).manifest;
const parties = JSON.parse(await readFile("site/data/parties.json", "utf8")).parties;
const slugOf = (acr) => {
  if (acr === "A") return "accord";
  const src = logos[acr]?.source;
  return src ? src.split("/").pop().split("_logo")[0] : null;
};
const FIELDS = ["National Chairman", "National Secretary", "National Treasurer", "National Financial Secretary", "National Legal Adviser", "Secretariat Address", "Telephone / Contact", "Official Email", "Official Website"];
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "\n").replace(/&amp;/g, "&").replace(/&#39;/g, "'").split("\n").map((s) => s.trim()).filter(Boolean);
const SOCIAL = /https?:\/\/(?:www\.)?(facebook\.com|x\.com|twitter\.com|instagram\.com|youtube\.com|tiktok\.com|threads\.(?:net|com))\/[A-Za-z0-9_.@\-\/?=]+/g;

const out = { source: "INEC party profile pages", fetchedAt: new Date().toISOString(), rule: "Social handles appear only when the party's official website (as listed by INEC) links to them.", parties: {} };
for (const p of parties) {
  const slug = slugOf(p.acronym);
  const url = `https://inecnigeria.org/parties/${slug}`;
  const t = text(await (await fetch(url, UA)).text());
  const title = t[t.indexOf("Recognized & Certified Party") + 1];
  if (!slug || title?.toLowerCase() !== p.name.toLowerCase()) { out.parties[p.acronym] = { error: `profile not matched (${slug})`, url }; console.log("skip", p.acronym, title); continue; }
  const rec = { url };
  for (const f of FIELDS) { const i = t.indexOf(f); const v = i >= 0 ? t[i + 1] : null; rec[f] = v && !FIELDS.includes(v) && v !== "N/A" ? v : null; }
  rec.socials = [];
  const site = rec["Official Website"];
  if (site && /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}/i.test(site)) {
    const siteUrl = site.startsWith("http") ? site : `https://${site}`;
    try {
      const ctrl = AbortSignal.timeout(8000);
      const html = await (await fetch(siteUrl, { ...UA, signal: ctrl })).text();
      const found = [...new Set((html.match(SOCIAL) ?? []).map((u) => u.replace(/[?#].*$/, "").replace(/\/$/, "")))]
        .filter((u) => !/sharer|share\?|intent\/|plugins|dialog|\/watch\b/i.test(u));
      rec.socials = found.slice(0, 8).map((u) => ({ url: u, verifiedVia: siteUrl }));
    } catch { rec.siteReachable = false; }
  }
  out.parties[p.acronym] = rec;
  console.log(p.acronym, "| chair:", rec["National Chairman"] ?? "—", "| site:", site ?? "—", "| socials:", rec.socials.length);
}
await writeFile("site/data/party-officials.json", JSON.stringify(out, null, 1));
