// Composes src/pages/*.html into site/ with the shared layout (masthead with INEC notice, clock, theme; footer).
// Each page starts with a JSON comment:
//   <!--{"title":"…","description":"…","nav":"map","path":"/map/","scripts":["/assets/js/map.js"],"head":"<link …>"}-->
// Usage: node scripts/build-site.mjs
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { loadTenant, tenantModule, localeJson } from "./lib/tenant.mjs";
import { readFileSync } from "node:fs";
import { parseKb, kbDrift, helpHtml } from "../functions/_lib/kb.js";
const awaitRead = (p) => readFileSync(p, "utf8");

const NAV = [
  ["monitor", "/tally/", "Live Tally Ledger"],
  ["map", "/map/", "Nigeria map"],
  ["parties", "/parties/", "Parties"],
  ["ledger", "/ledger/", "Ledger"],
  ["verifiers", "/verifiers/", "Verifiers"],
  ["vote", "/vote/", "How to vote"],
  ["about", "/about/", "About"],
];
// The one approved description of the pipeline, and the rule for when the result sheet is missing (owner wording,
// session 53). Pages use {{PIPELINE}} and {{EC8A_RULE}}, and the footer repeats PIPELINE on every page, so the
// wording cannot drift between pages. Smoke tests check both.
const PIPELINE = "Citizens photograph or report the posted result sheet. Binchika compares those reports with INEC's IReV uploads and writes high-agreement tallies to a public hash-chained ledger. Only INEC declares results.";
const EC8A_RULE = "<strong>If Form EC8A is not available:</strong> other evidence, such as a video, handwritten numbers or a photo of the results board, is accepted only after a verifier has audited it, and it is marked as lower-confidence.";
// The active country (session 98): tenant_config.json → tenants/<id>/tenant.json. The generated module is committed so
// tests and Pages Functions work before a build; the build rewrites it and site/data/locale.json from the tenant.
const TENANT = loadTenant();
await writeFile("functions/_lib/tenant.generated.js", tenantModule(TENANT));
await writeFile("site/data/locale.json", localeJson(TENANT));
const ORIGIN = TENANT.site.origin;
const V = Date.now().toString(36);
// Preload the body face (latin, 400) so text renders without a font swap flash.
const F_BODY = (() => {
  try {
    const css = awaitRead("site/assets/vendor/fonts.css");
    const b = css.split("/* ").filter((x) => x.startsWith("latin */")).find((x) => /Atkinson Hyperlegible/.test(x) && /font-style: normal/.test(x) && /font-weight: 400/.test(x));
    return b.match(/fonts\/([^)]+\.woff2)/)[1];
  } catch { return ""; }
})();
const STYLESHEETS = `<link rel="stylesheet" href="/assets/vendor/fonts.css?v=${V}">
<link rel="stylesheet" href="/assets/css/main.css?v=${V}">
<link rel="stylesheet" href="/assets/css/v3.css?v=${V}">`;
// Prepared, off by default: pages with "critical": true inline src/critical/home.css and load the full stylesheets after
// the hero (<!--CSS-AFTER-HERO-->). Only with CRITICAL_CSS=1, and only while that file matches the current CSS
// (scripts/build-critical-css.mjs explains why it is not live yet).
const CRITICAL = await (async () => {
  if (process.env.CRITICAL_CSS !== "1") return null;
  const { cssHash } = await import("./build-critical-css.mjs");
  const css = await readFile("src/critical/home.css", "utf8").catch(() => "");
  if (css.includes(`sources-sha256: ${cssHash()} `)) return css;
  console.warn("CRITICAL_CSS=1 ignored: src/critical/home.css is missing or out of date; run scripts/build-critical-css.mjs");
  return null;
})();

const SUN = `<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>`;
const MOON = `<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.6A8.5 8.5 0 1 1 9.4 3.5a7 7 0 0 0 11.1 11.1Z"/></svg>`;
const MENU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;
const KEY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>`;

// Social placeholders (accounts not yet created): glyphs from Simple Icons (CC0)
// Official @getbinchika accounts; entries without a URL are placeholders (dimmed, not links).
const SOCIAL = [
  ["facebook", "Facebook", "https://www.facebook.com/profile.php?id=61596030114590"],
  ["x", "X", "https://x.com/getbinchika"],
  ["instagram", "Instagram", "https://www.instagram.com/getbinchika/"],
  ["threads", "Threads", "https://www.threads.com/@getbinchika"],
  ["youtube", "YouTube", "https://www.youtube.com/@getbinchika"],
  ["reddit", "Reddit", "https://www.reddit.com/user/getbinchika/"],
  ["whatsapp", "WhatsApp", null], ["telegram", "Telegram", null], ["discord", "Discord", null], ["tiktok", "TikTok", null],
];
const socialSvg = {};
for (const [slug] of SOCIAL) socialSvg[slug] = await readFile(`site/assets/img/social/${slug}.svg`, "utf8").catch(() => "");

export const wordmark = (tag = "span", cls = "") => `<${tag} class="wordmark ${cls}" aria-label="Binchika"><span aria-hidden="true">Bin</span><span class="wm-hot" aria-hidden="true">chika</span></${tag}>`;

const layout = (m, body) => `<!doctype html>
<html lang="en-GB" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${m.title}</title>
<meta name="description" content="${m.description}">${m.draft ? `\n<meta name="robots" content="noindex">` : ""}
${m.file ? "" : `<link rel="canonical" href="${ORIGIN}${m.path}">`}
<meta name="theme-color" content="#F6F5F1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0A0B0D" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Binchika · Africa's First Decentralised Election Ledger">
<meta property="og:locale" content="en_GB">
<meta property="og:title" content="${m.title}">
<meta property="og:description" content="${m.description}">
${m.file ? "" : `<meta property="og:url" content="${ORIGIN}${m.path}">`}
<meta property="og:image" content="${ORIGIN}/assets/img/brand/agogo-1024.png">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/assets/img/brand/favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="/assets/img/brand/agogo-256.png" sizes="256x256" type="image/png">
<link rel="apple-touch-icon" href="/assets/img/brand/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/vendor/fonts/${F_BODY}">
${m.critical && CRITICAL ? `<style>${CRITICAL}</style>` : STYLESHEETS}
${m.head ?? ""}
<script src="/assets/js/theme-init.js?v=${V}"></script>
</head>
<body class="page-${m.nav}">
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
  <div class="notice" role="note"><div class="wrap">
    <span><strong>Not official results.</strong> Only <a href="https://www.inecnigeria.org/" rel="noopener">INEC</a> declares election results in Nigeria. Binchika is a citizen transparency layer.</span>
    <span class="pledge-line">No party ads · equal space for all 22 parties · <a href="/about/#rules">our rules</a></span>
  </div></div>
  <div class="bar"><div class="wrap">
    <a class="brand" href="/" aria-label="Binchika home"><img src="/assets/img/brand/agogo-128.webp" alt="" width="42" height="42">${wordmark("span", "wm-sm")}</a>
    <nav class="nav" id="nav" aria-label="Main">
      ${NAV.map(([k, href, label]) => `<a href="${href}"${m.nav === k ? ' aria-current="page"' : ""}>${label}</a>`).join("\n      ")}
      <a class="nav-portal" href="/portal/"${m.nav === "portal" ? ' aria-current="page"' : ""}>Verifier &amp; admin sign-in</a>
    </nav>
    <div class="clock" data-clock aria-label="Local time in Nigeria"><span class="clock-time" data-clock-time>--:--:--</span><span class="clock-meta" data-clock-meta>Abuja · WAT (UTC+1)</span></div>
    <a class="icon-btn portal-btn" href="/portal/" aria-label="Verifier and admin sign-in"${m.nav === "portal" ? ' aria-current="page"' : ""}>${KEY}</a>
    <button class="icon-btn theme-btn" type="button" data-theme-toggle aria-label="Switch colour theme">${SUN}${MOON}</button>
    <button class="icon-btn menu-btn" type="button" aria-expanded="false" aria-controls="nav" aria-label="Menu">${MENU}</button>
  </div></div>
</header>
<main id="main">
${body}
</main>
<footer class="site-foot">
  <div class="wrap foot-min">
    <ul class="socials" aria-label="Binchika on social media: @getbinchika">
      ${SOCIAL.map(([slug, name, url]) => url
        ? `<li><a class="social" href="${url}" rel="noopener me" target="_blank" title="Binchika on ${name} (@getbinchika)" aria-label="Binchika on ${name} (opens in a new tab)" data-social="${slug}">${socialSvg[slug]}</a></li>`
        : `<li><span class="social soon" role="img" title="${name}: coming soon" aria-label="${name}: coming soon" data-social="${slug}">${socialSvg[slug]}</span></li>`).join("\n      ")}
    </ul>
    <p class="foot-line">© 2026 Oruanyi. All rights reserved. <span class="sep" aria-hidden="true">|</span> Designed and maintained by
      <a class="oru" href="https://oruanyi.com/" rel="noopener"><picture><source srcset="/assets/img/brand/oruanyi.webp" type="image/webp"><img src="/assets/img/brand/oruanyi.png" alt="Oruanyi" width="97" height="36"></picture></a></p>
    <p class="foot-small foot-pipeline">${PIPELINE}</p>
    <p class="foot-small"><a href="/help/">Help</a> · <a href="/contact/">Contact</a> · <a href="/media/">For newsrooms</a> · <a href="/governance/">AI governance</a> · <a href="/sources/">Sources &amp; licences</a> · <a href="${TENANT.site.sourceRepo}" rel="noopener">Open source (MIT)</a></p>
  </div>
</footer>
<script src="/assets/js/site.js?v=${V}" type="module"></script>
${(m.scripts || []).map((s) => `<script src="${s}?v=${V}" type="module"></script>`).join("\n")}
</body>
</html>
`;

// Draft pages (src/drafts/) are built only with BUILD_DRAFTS=1, for a local look; a normal build deletes their output
// so a draft can never be deployed by accident.
const BUILD_DRAFTS = process.env.BUILD_DRAFTS === "1";
const pages = (await readdir("src/pages")).filter((f) => f.endsWith(".html")).map((f) => `src/pages/${f}`);
// Knowledge base (session 80, phase K1; docs/KNOWLEDGE-BASE-DESIGN.md): owner-approved answers in src/kb/, drawn only
// from published pages. /help/ shows them, the Tickets API suggests them (functions/_lib/kb.generated.js), and the check
// after the build refuses to finish if any sentence an answer relies on has left its page.
const KB = (await Promise.all((await readdir("src/kb")).filter((f) => f.endsWith(".md")).map(async (f) => parseKb(await readFile(`src/kb/${f}`, "utf8"), `src/kb/${f}`))))
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id));
if (new Set(KB.map((e) => e.id)).size !== KB.length) throw new Error("src/kb: two answers share an id");
await writeFile("functions/_lib/kb.generated.js", `// Generated by scripts/build-site.mjs from src/kb/*.md. Do not edit: change src/kb and rebuild.
export const KB = ${JSON.stringify(KB.map(({ id, question, topics, match, link, body }) => ({ id, question, topics, match, link, body })), null, 1)};
`);
for (const f of (await readdir("src/drafts").catch(() => [])).filter((f) => f.endsWith(".html"))) {
  const path = JSON.parse((await readFile(`src/drafts/${f}`, "utf8")).match(/^<!--(\{[\s\S]*?\})-->/)[1]).path;
  if (BUILD_DRAFTS) pages.push(`src/drafts/${f}`);
  else if (path !== "/") await rm(`site${path}`, { recursive: true, force: true });
}
// Register totals (/register/, published 28 Oct 2026 as option B): national and zone figures from data/register-2026/aggregates.json, refused unless
// the zones add up exactly to the national total. No state list (docs/INEC-PRELIMINARY-REGISTER-2027.md §4a).
function registerParts() {
  const A = JSON.parse(awaitRead("data/register-2026/aggregates.json"));
  const nf = new Intl.NumberFormat("en-GB"), ch = (a, b) => { const x = (a / b - 1) * 100; return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`; };
  const z = A.zones, N = A.national;
  if (z.order.reduce((s, k) => s + z["2026"][k], 0) !== N["2026"]) throw new Error("register: 2026 zones do not add up to the national total");
  // 2026 first so it stays on screen on phones; names and headings may wrap (table.data cells are nowrap by default)
  const W = ' style="white-space:normal"';
  const row = (name, a, b, strong) => { const s = (v) => (strong ? `<strong>${v}</strong>` : v);
    return `<tr><th scope="row"${W}>${s(name)}</th><td class="num">${s(nf.format(b))}</td><td class="num">${s(nf.format(a))}</td><td class="num">${s(ch(b, a))}</td></tr>`; };
  const table = `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">Registered voters by geopolitical zone, 2026 (preliminary) and 2023</caption><thead><tr><th scope="col"${W}>Zone</th><th scope="col" class="num"${W}>2026 (preliminary)</th><th scope="col" class="num">2023</th><th scope="col" class="num">Change</th></tr></thead><tbody>${z.order.map((k) => row(z.names[k], z["2023"][k], z["2026"][k])).join("")}${row("Nigeria", N["2023"], N["2026"], true)}</tbody></table></div>`;
  const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const link = (u) => `<a href="${e(u)}" rel="noopener">${e(new URL(u).hostname.replace(/^www\./, ""))}</a>`;
  const sources = `<ul class="source-note" style="padding-left:1.2rem;display:grid;gap:.3rem">
<li><strong>2023:</strong> INEC, registered voters and PVCs collected for the 2023 general election: ${link(N.source2023)}. Zone totals are summed from INEC's state figures.</li>
<li><strong>2026, national:</strong> INEC's announcement of 6 October 2026, as reported by ${[...new Set(N.sources2026)].map(link).join(" and ")}.</li>
<li><strong>2026, zones:</strong> as reported by ${[...new Set(z.sources2026)].map(link).join(" and ")}. The six zones add up exactly to ${nf.format(N["2026"])}.</li>
<li>Compiled ${e(A.compiled)}. ${e(A.status)}</li>
</ul>`;
  // /tally/ (formerly /monitor/) register analysis (session 44): the ten largest states as INEC's chairman announced them on 6 Oct 2026. Not the
  // 37-state press table (verified: false). The 2023 column must match INEC's own 2023 state figures, or the page is not built.
  const base = JSON.parse(awaitRead("site/data/baselines/registered-voters.json")).state;
  const isoOf = Object.fromEntries(JSON.parse(awaitRead("site/data/states.json")).states.map((s) => [s.name, s.iso]));
  for (const r of A.topStates.rows) if (base[isoOf[r.state]]?.registered !== r["2023"]) throw new Error(`register: 2023 figure for ${r.state} does not match INEC's 2023 table`);
  const topTable = `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">The ten states with the most registered voters, 2026 (preliminary, as announced) and 2023</caption><thead><tr><th scope="col"${W}>State</th><th scope="col" class="num"${W}>2026 (preliminary)</th><th scope="col" class="num">2023</th><th scope="col" class="num">Change</th></tr></thead><tbody>${A.topStates.rows.map((r) => row(r.state, r["2023"], r["2026"])).join("")}</tbody></table></div>`;
  const topSources = [...new Set(A.topStates.sources2026)].map(link).join(", ");
  return { table, sources, topTable, topSources };
}
// Pre-rendered first screen of headlines (site/data/news-snapshot.json, written by scripts/snapshot-news.mjs).
// Shown at first paint without waiting for /api/news; news.js swaps in the live feed after load.
const newsSnap = await readFile("site/data/news-snapshot.json", "utf8").then(JSON.parse).catch(() => null);
function newsSnapshotHtml() {
  if (!newsSnap?.items?.length) return '<p class="muted">Loading headlines…</p>';
  const e = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const when = new Date(newsSnap.fetchedAt).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return newsSnap.items.filter((i) => /^https?:\/\//.test(i.link)).map((i) => `<article><span class="src">${e(i.source)}</span><h3><a href="${e(i.link)}" rel="noopener" target="_blank">${e(i.title)}<span class="sr-only"> (opens in a new tab)</span></a></h3><span class="muted" style="font-size:.8rem">${e(new Date(i.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }))}</span></article>`).join("")
    + `<p class="muted news-snap-note" style="font-size:.78rem;grid-column:1/-1">Headlines as of ${e(when)} WAT · updating…</p>`;
}

const built = [];
for (const f of pages) {
  const src = await readFile(f, "utf8");
  const match = src.match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!match) throw new Error(`${f}: missing meta comment`);
  const meta = JSON.parse(match[1]);
  if (meta.draft && f.startsWith("src/pages/")) throw new Error(`${f}: still marked "draft"; remove the flag and the "not yet approved" line once the owner approves publication`);
  // A page with "file" is written to that name at the site root instead of <path>/index.html. Only site/404.html uses it
  // (session 91, owner-approved): Cloudflare Pages serves it with a real 404 status for any address that matches no file
  // or Function, instead of the home page with 200.
  const outDir = meta.file ? "site" : meta.path === "/" ? "site" : `site${meta.path}`;
  await mkdir(outDir, { recursive: true });
  let body = src.slice(match[0].length).replaceAll("{{WORDMARK}}", wordmark("span", "wm-hero"));
  body = body.replace('<p class="muted">Loading headlines…</p>', newsSnapshotHtml());
  body = body.replace("<!--CSS-AFTER-HERO-->", meta.critical && CRITICAL ? `\n${STYLESHEETS}` : "");
  if (body.includes("{{REGISTER_")) { const r = registerParts(); body = body.replace("{{REGISTER_ZONE_TABLE}}", r.table).replace("{{REGISTER_SOURCES}}", r.sources).replace("{{REGISTER_TOP_STATES}}", r.topTable).replace("{{REGISTER_TOP_SOURCES}}", r.topSources); }
  body = body.replaceAll("{{PIPELINE}}", PIPELINE).replaceAll("{{EC8A_RULE}}", EC8A_RULE).replace("{{KB_HELP}}", () => helpHtml(KB));
  if (/\{\{[A-Z_]+\}\}/.test(body)) throw new Error(`${f}: unfilled placeholder ${body.match(/\{\{[A-Z_]+\}\}/)[0]}`);
  const html = layout(meta, body);
  await writeFile(`${outDir}/${meta.file ?? "index.html"}`, html);
  built.push({ path: meta.path, listed: !meta.draft && !/<meta name="robots" content="noindex/.test(html) });
  console.log("built", meta.path);
}

// Knowledge-base drift check: every sentence an answer relies on must still be on its built page.
const drift = kbDrift(KB, (page) => readFileSync(page === "/" ? "site/index.html" : `site${page}index.html`, "utf8"));
if (drift.length) throw new Error(`knowledge base out of date; update src/kb (and get the owner's approval) before building:\n  ${drift.join("\n  ")}`);
console.log(`knowledge base: ${KB.length} answers, every source sentence found`);

// sitemap.xml lists exactly the pages built above, so it can't drift. Drafts and noindex pages (the invite and pledge
// steps) are left out.
const urls = built.filter((b) => b.listed).map((b) => b.path).sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
await writeFile("site/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${ORIGIN}${u}</loc></url>`).join("\n")}
</urlset>
`);
console.log(`sitemap.xml: ${urls.length} pages`);

// Shared pure libraries: the browser verifies with exactly the code the server uses.
await mkdir("site/assets/js/lib", { recursive: true });
for (const lib of ["ledger.js", "consensus.js", "baseline.js", "screening.js", "results.js", "tenant.generated.js"]) await copyFile(`functions/_lib/${lib}`, `site/assets/js/lib/${lib}`);
console.log("copied shared libs");
