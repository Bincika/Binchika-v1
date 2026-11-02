// Live smoke test. Usage: node scripts/smoke.mjs https://your-project.pages.dev
// Reads INGEST_TOKEN from .env for the positive ingestion test; never prints it.
import { readFile } from "node:fs/promises";

const base = (process.argv[2] ?? "https://your-project.pages.dev").replace(/\/$/, "");
const env = await readFile(".env", "utf8").catch(() => "");
const token = env.match(/^INGEST_TOKEN=(.+)$/m)?.[1]?.trim();
let fail = 0;
const check = (ok, label, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`); if (!ok) fail++; };

for (const p of ["/", "/tally/", "/portal/", "/sources/", "/api/config", "/data/baselines/registered-voters.json", "/data/world/c/566.json", "/assets/img/brand/agogo-128.webp", "/assets/img/renders/nigeria-bronze-2400.webp", "/api/news", "/api/ledger", "/api/results?race=president", "/data/world/countries.json", "/data/party-logos.json", "/assets/img/parties/apc.webp", "/map/", "/parties/", "/verifiers/", "/ledger/", "/about/", "/privacy/", "/join/", "/register/", "/data/states.json", "/data/geo/ng-lgas.topo.json", "/favicon.svg", "/data/ledger/index.json"]) {
  const r = await fetch(base + p);
  const body = await r.text();
  const leaks = /(accounts|ops|noreply)@binchika.com/.test(body);
  if (p.endsWith("/")) check(!leaks, `no functional email on ${p}`);
  const okHtml = !p.endsWith("/") || p.startsWith("/api") || body.includes("Only <a href=\"https://www.inecnigeria.org/\"");
  check(r.status === 200 && okHtml, `GET ${p}`, `${r.status}${p.endsWith("/") ? (okHtml ? " · INEC notice present" : " · INEC notice MISSING") : ""}`);
}
const h = await fetch(base + "/");
check(Boolean(h.headers.get("content-security-policy")), "CSP header present");
// /register/: national and zone totals only. Check the content, not only the status (before session 91 unknown paths fell back to the home page with 200).
const reg = await (await fetch(base + "/register/")).text();
const regOk = reg.includes("Figures from published sources, not an official INEC table") && reg.includes("North-Central (incl. FCT)") && !/not yet approved for publication|name="robots" content="noindex"/.test(reg) && !/>(Lagos|Kano|Sokoto|Ekiti)</.test(reg);
check(regOk, "GET /register/ is the published zone-totals page (disclaimer, no draft label, no state rows)");
// /tally/ (formerly /monitor/) register analysis (session 44): sourced totals and open questions for INEC; only the ten states INEC announced,
// never the press-reported 37-state table (Sokoto, Jigawa and Ekiti are outside the announced top ten).
const mon = await (await fetch(base + "/tally/")).text();
check(mon.includes("Open questions for INEC") && mon.includes("Figures from published sources, not an official INEC table") && mon.includes("103,428,715") && mon.includes('id="mon-map"') && !/>(Sokoto|Jigawa|Ekiti)</.test(mon), "GET /tally/ has the register analysis and questions (top ten states only, monitor intact)");
// /privacy/ mailbox wording (owner-approved, session 51): stored dashboard mail, the automatic reply and 12-month retention,
// while the notice as a whole stays marked "not yet in force".
const priv = await (await fetch(base + "/privacy/")).text();
// Session 62: owner-accepted recommendations applied (photos never published; pseudonymous; one-month answers), still a draft.
check(priv.includes("Owner / legal review required before this notice can take effect") && priv.includes("We never publish photos.") && priv.includes("Pseudonymous in public.") && priv.includes("one automatic reply") && priv.includes("12 months after the date of the message") && priv.includes("Draft for review: not yet in force.") && !priv.includes("Anonymous by default"), "GET /privacy/ has the accepted privacy decisions and mailbox wording (still not in force)");
// Session 53 legal wording: the owner's standard pipeline sentence (in every footer and on the key pages), the rule for a
// missing Form EC8A, no leader/victory framing, the launch banner (5 Nov since session 83; was 1 Nov), and the /monitor/ race dashboard with its disclaimer.
const PIPE = "Citizens photograph or report the posted result sheet. Binchika compares those reports with INEC's IReV uploads and writes high-agreement tallies to a public hash-chained ledger. Only INEC declares results.";
const page = async (p) => (await fetch(base + p)).text();
const [home, ledgerPage, verPage] = await Promise.all(["/", "/ledger/", "/verifiers/"].map(page));
const pipeOk = [home, mon, ledgerPage, verPage, priv].every((t) => t.replaceAll("&#39;", "'").includes(PIPE));
check(pipeOk && home.includes("If Form EC8A is not available") && verPage.includes("If Form EC8A is not available") && !/Who is leading\?|leading \(citizen count\)|Leader \(citizen count\)|Leading \(citizen count\)/.test(home + mon + ledgerPage), "standard pipeline wording and the Form EC8A rule are live; no leader framing");
check(!verPage.includes("NIN (optional)") && home.includes("Public launch: Thursday 5 November 2026.") && home.includes("Site readiness testing is ongoing.") && !home.includes("Public launch: Sunday 1 November") && home.includes("Citizen reports and verifier applications open later, once our privacy notice is in force") && !home.includes("citizen reporting layer goes public on 1 November") && !verPage.includes("∞") && verPage.includes("2–16 November 2026"), "home launch banner (5 November, readiness testing ongoing); verifier window 2–16 Nov; new citizen-monitor icon");
check(mon.includes('id="rd-panel"') && mon.includes("This is a public ledger of citizen-reported tallies. Only INEC declares results.") && mon.includes('id="rd-hide"') && mon.includes('id="rd-snap"') && mon.indexOf('id="rd-panel"') < mon.indexOf('id="mon-map"'), "GET /monitor/ has the race dashboard (toggle, snapshot, disclaimer) above the existing monitor");
// Session 76: founder quote under the motto; Election Monitor renamed Live Tally Ledger at /tally/ (old /monitor/ links
// redirect).
const oldMon = await fetch(base + "/monitor/", { redirect: "manual" });
check(oldMon.status === 301 && new URL(oldMon.headers.get("location") ?? "", base).pathname === "/tally/", "GET /monitor/ redirects 301 to /tally/", `${oldMon.status} ${oldMon.headers.get("location")}`);
check(home.includes("An untransparent election is <span class=\"fq-key\">a selection!</span>") && home.includes("— Binchika Founder") && home.includes('href="/tally/">Live Tally Ledger</a>') && !home.includes('href="/monitor/"'), "home has the founder quote and links to /tally/");
// Session 76 (after migration 0012): truthful correction wording ("Consensus-Approved Corrections", three separate seats,
// quorum only planned), and no single-seat approval wording left on the public pages.
const CORR = "No single person can change a result. A correction needs three separate seats: the verifier who flags it, a Regional Verifier who escalates it, and the BinchikAdmin, who records it after the AI re-check. Approved fixes are new ledger entries, so nothing is erased.";
const [aboutPage, govPage] = await Promise.all(["/about/", "/governance/"].map(page));
check(verPage.includes("Consensus-Approved Corrections") && verPage.includes(CORR) && verPage.includes("(Planned: a quorum of at least 5 of 7 randomly assigned Regional Verifiers.)") && [verPage, aboutPage, govPage, ledgerPage].every((t) => !/BinchikAdmin decides|Only the BinchikAdmin (can )?approves?|BinchikAdmin, always/.test(t)), "correction wording: three separate seats, no single-seat approval");
// Session 80: knowledge base K1. /help/ lists the approved answers (each linking to its source page), the footer links to
// it, and /verifiers/ carries the screening dates aligned with /verifiers/apply/.
const helpPage = await page("/help/");
check(helpPage.includes('id="verifier-timeline"') && (helpPage.match(/class="kb-item panel"/g) ?? []).length >= 5 && helpPage.includes("proposed for 2–16 November 2026") && home.includes('href="/help/">Help</a>') && verPage.includes("Screening: 17 November – 4 December (proposed), about two and a half weeks."), "help page lists the approved answers; screening wording aligned");
// Session 54: SZV recalibration (migration 0010): 129 SZV + 24 NRV seats; Lagos and Kano 7; five states 5; others 3.
const seatList = (await (await fetch(base + "/api/seats")).json()).seats ?? [];
const perState = {}; for (const s of seatList) if (s.role === "szv") perState[s.state_iso] = (perState[s.state_iso] ?? 0) + 1;
const bigStates = Object.entries(perState).filter(([, n]) => n > 3).map(([k, n]) => `${k}:${n}`).sort().join(",");
check(seatList.length === 153 && Object.keys(perState).length === 37 && Object.values(perState).every((n) => [3, 5, 7].includes(n)) && bigStates === "NG-DE:5,NG-KD:5,NG-KN:7,NG-KT:5,NG-LA:7,NG-OY:5,NG-RI:5" && verPage.includes("153 numbered seats") && verPage.includes(">129<"), "GET /api/seats: 129 SZV (3/5/7 per state) + 24 NRV, matching /verifiers/", `${seatList.length} seats`);
// Session 55: alternative evidence (no Form EC8A) is audited only by a signed-in SZV/NRV; the rule book explains it.
const evAnon = await fetch(base + "/api/portal/evidence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reportId: "x", decision: "approved", note: "smoke test, no session" }) });
const rulebook = await page("/portal/rulebook/");
check(evAnon.status === 401 && rulebook.includes("Auditing it is your job.") && rulebook.includes("If Form EC8A is not available"), "evidence audit API refuses anonymous callers; rule book has the audit rule", String(evAnon.status));
// Session 57: the evidence viewer's media endpoint is for signed-in, MFA-verified SZV/NRV only; video may play from blob:.
const evMedia = await fetch(base + "/api/portal/evidence-media?id=x");
check(evMedia.status === 401 && /media-src 'self' blob:/.test(h.headers.get("content-security-policy") ?? ""), "evidence media API refuses anonymous callers; CSP allows the viewer's blob video", String(evMedia.status));
// Session 58: the photo pipeline's entry point is token-only, so public photo intake stays closed.
const pipeAnon = await fetch(base + "/api/pipeline/media?id=x", { method: "POST", headers: { "content-type": "image/jpeg" }, body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) });
check(pipeAnon.status === 401, "photo pipeline refuses callers without the ingest token (intake closed)", String(pipeAnon.status));
// sitemap.xml is generated by the build: public pages only, each of which must load with the INEC notice.
const locs = [...(await (await fetch(base + "/sitemap.xml")).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
const bad = [];
for (const p of locs) { const r = await fetch(base + p); if (r.status !== 200 || !(await r.text()).includes("Only <a href=\"https://www.inecnigeria.org/\"")) bad.push(p); }
check(locs.includes("/register/") && locs.includes("/vote/") && !locs.includes("/join/") && bad.length === 0, "sitemap.xml lists public pages only, all loading", `${locs.length} URLs${bad.length ? "; failing: " + bad.join(", ") : ""}`);

// Dashboard mailbox (Inbox & Sent): BinchikAdmin + MFA only, so every mail endpoint must refuse an anonymous caller.
const mailGate = await Promise.all([fetch(base + "/api/admin/mail"), fetch(base + "/api/admin/mail/send", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), fetch(base + "/api/admin/mail/attachment?id=x&n=0"), fetch(base + "/api/admin/mail/x", { method: "DELETE" })]);
check(mailGate.every((r) => r.status === 401), "mail APIs refuse anonymous callers", mailGate.map((r) => r.status).join(","));
// Session 78: contact-form tickets (BIN-YYMM-NNNN), same gate.
const tkGate = await Promise.all([fetch(base + "/api/admin/tickets"), fetch(base + "/api/admin/tickets/BIN-2611-0001", { method: "POST", headers: { "content-type": "application/json" }, body: '{"status":"closed"}' })]);
check(tkGate.every((r) => r.status === 401), "ticket APIs refuse anonymous callers", tkGate.map((r) => r.status).join(","));
// Session 88 (readiness gaps): the new OCR, official-result and verifier-review routes refuse anonymous callers.
const s88 = await Promise.all(["/api/pipeline/ocr", "/api/pipeline/official", "/api/portal/review"].map((p) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
check(s88.every((r) => r.status === 401), "OCR, official-result and review routes refuse anonymous callers", s88.map((r) => r.status).join(","));
// Session 90: GET on those write routes (and on admin decide) is 405 with "Allow: POST", not the home page (soft 404).
const g90 = await Promise.all(["/api/pipeline/ocr", "/api/pipeline/official", "/api/portal/review", "/api/admin/decide"].map((p) => fetch(base + p)));
check(g90.every((r) => r.status === 405 && r.headers.get("allow") === "POST"), "write routes answer GET with 405 (no soft 404)", g90.map((r) => r.status).join(","));
// Press and civic feed: read-only aggregates with the notice, cacheable, and nothing personal or evidential in it.
const press = await fetch(base + "/api/press/snapshot?race=president");
const pressText = await press.text();
check(press.status === 200 && pressText.includes("Only INEC declares results") && /public, max-age=15/.test(press.headers.get("cache-control") ?? "") && !/reporter|caption|media_ref|audited_by|public_id|"leader"|"winner"/.test(pressText), "press snapshot: aggregates only, notice, cacheable", String(press.status));
check((await fetch(base + "/api/press/snapshot?race=winner")).status === 400 && (await fetch(base + "/api/press/snapshot", { method: "POST" })).status !== 200, "press snapshot refuses unknown races and is GET-only");
// Session 91 (owner-approved): re-wordings 2, 3, 6, 9 and 10 of docs/reports/2026-11-01-audit2-inspection.md are live, and
// an unknown page returns the branded site/404.html with a real 404 status instead of the home page with 200.
const [srcPage, mapJs] = await Promise.all(["/sources/", "/assets/js/map3d.js"].map(page));
check(verPage.includes("<strong>People confirm the reading</strong>") && !verPage.includes("Machines agree") && verPage.includes("Reporting is not open during readiness testing.") && !verPage.includes("arrive by Telegram, WhatsApp") && mapJs.includes("Seat counts are not shown. These tallies are not a constituency allocation.") && !mapJs.includes("Seat counts appear as constituencies report.") && srcPage.includes("Binchika does not apply them as a declaration.") && !srcPage.includes("winning thresholds") && JSON.parse(pressText).notice === "Citizen-verified tallies. Only INEC declares results.", "approved re-wordings live (/verifiers/ steps 1-2, /map/ road panel, /sources/ thresholds, press notice)");
const nf = await fetch(base + "/this-page-does-not-exist-s91/");
const nfText = await nf.text();
check(nf.status === 404 && nfText.includes("Page not found · Binchika") && nfText.includes('href="/vote/"') && nfText.includes('name="robots" content="noindex"') && nfText.includes("Only <a href=\"https://www.inecnigeria.org/\""), "unknown page returns the branded 404 (status 404, links to / and /vote/, noindex)", String(nf.status));
// Session 91: the contact form offers a media access request (press-feed registration); its fields are hidden until chosen.
const contactPage = await page("/contact/");
check(contactPage.includes('<option value="media_access">Media access request (press feed)</option>') && contactPage.includes('id="c-media" hidden') && contactPage.includes('name="org_url"') && contactPage.includes('name="terms"') && contactPage.includes("deleted after 12 months"), "contact form offers the media access request (fields hidden until chosen)");
// Session 92: /media/ explains the open press feed and hosts the media registration request (posts to /api/contact).
const mediaPage = await page("/media/");
check(mediaPage.includes('id="media-form"') && mediaPage.includes('name="reg_no"') && mediaPage.includes('name="tech_email"') && mediaPage.includes("Public launch: Thursday 5 November 2026.") && mediaPage.includes("Site readiness testing is ongoing.") && mediaPage.includes("Never present the figures as official results, a projection or a winner.") && mediaPage.includes("Only <a href=\"https://www.inecnigeria.org/\"") && !/(accounts|ops|noreply)@binchika\.com/.test(mediaPage), "GET /media/ has the request form, the terms, the launch banner and the INEC notice (no functional email)");
const cfg = await (await fetch(base + "/api/config")).json();
check(!("adminDecisions" in cfg), "config does not say whether a service role is configured");
const res88 = await (await fetch(base + "/api/results?race=president")).json();
check(typeof res88.irev?.compared === "number" && typeof res88.irev?.mismatches === "number", "results show the IReV comparison counts");

const health = await (await fetch(base + "/api/health")).json();
check(health.ok && health.db && health.ingest, "GET /api/health", JSON.stringify({ db: health.db, ingest: health.ingest, telegram: health.telegram }));

const sample = { channel: "web", handle: "smoke-test", puCode: "00-00-00-000", race: "president", tally: { TEST: 1 }, caption: "SMOKE TEST — delete" };
const noAuth = await fetch(base + "/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample) });
check(noAuth.status === 401, "POST /api/reports without token is rejected", String(noAuth.status));
const badAuth = await fetch(base + "/api/reports", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify(sample) });
check(badAuth.status === 401, "POST /api/reports with wrong token is rejected", String(badAuth.status));
const tg = await fetch(base + "/api/telegram", { method: "POST", body: "{}" });
check(tg.status === 503 || tg.status === 403, "POST /api/telegram unconfigured/unauthorised is refused", String(tg.status));

// Writes one row to D1; opt-in with --write, then delete it (see docs/HANDOFF.md).
if (token && process.argv.includes("--write")) {
  const bad = await fetch(base + "/api/reports", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ...sample, puCode: "bad" }) });
  check(bad.status === 422, "POST invalid report with token → 422", String(bad.status));
  const good = await fetch(base + "/api/reports", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ ...sample, puCode: "37-01-01-901", tally: { TEST: 1 } }) });
  const gj = await good.json();
  check(good.status === 201 && gj.id, "POST valid report with token → 201", String(good.status));
  console.log("SMOKE_ROW_ID", gj.id ?? "none");
}
const counts = await (await fetch(base + "/api/reports")).json();
check(typeof counts.total === "number" && !("rows" in counts), "GET /api/reports returns aggregates only", JSON.stringify(counts));
process.exit(fail ? 1 : 0);
