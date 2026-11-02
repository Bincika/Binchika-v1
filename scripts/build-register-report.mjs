// Builds the INEC preliminary-register summary from AGGREGATE figures only (data/register-2026/aggregates.json):
//   docs/reports/inec-register-2027-summary.md   (source text)
//   docs/reports/inec-register-2027-summary.pdf  (charts + risk matrix, A4, via headless Chrome)
// No individual voter data is read or written. Usage: node scripts/build-register-report.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = JSON.parse(readFileSync("data/register-2026/aggregates.json", "utf8"));
const OUT = "docs/reports";
mkdirSync(OUT, { recursive: true });

const nf = new Intl.NumberFormat("en-GB");
const pct = (a, b) => ((a / b - 1) * 100);
const p1 = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- derived figures (arithmetic on published numbers only) ----
const N26 = A.national["2026"], N23 = A.national["2023"], NEW = A.national.newRegistrationsCVR;
const growth = N26 - N23, gap = NEW - growth;
const zones = A.zones.order.map((z) => ({ z, name: A.zones.names[z], v26: A.zones["2026"][z], v23: A.zones["2023"][z], g: pct(A.zones["2026"][z], A.zones["2023"][z]) }));
const zoneSum = zones.reduce((s, x) => s + x.v26, 0);
const top = A.topStates.rows.map((r) => ({ ...r, g: pct(r["2026"], r["2023"]) }));
const topShare = top.reduce((s, r) => s + r["2026"], 0) / N26 * 100;
const g = A.gender2026, age = A.age2026;
// press-reported 37-state table (verified: false): accepted only if every zone's states add up to INEC's zone total
const S = A.allStates2026;
const states = S.rows.map((r) => ({ ...r, g: pct(r["2026"], r["2023"]) })).sort((a, b) => b["2026"] - a["2026"]);
const byGrowth = [...states].sort((a, b) => b.g - a.g);
const checks = {
  zoneSumMatches: zoneSum === N26, genderSumMatches: g.male + g.female === N26,
  states37: states.length === 37, statesSumMatches: states.reduce((s, r) => s + r["2026"], 0) === N26,
  stateZonesMatch: A.zones.order.every((z) => states.filter((r) => r.zone === z).reduce((s, r) => s + r["2026"], 0) === A.zones["2026"][z]),
  topTenMatch: top.every((t) => states.some((r) => r.state === t.state && r["2026"] === t["2026"] && r["2023"] === t["2023"])),
};
console.log(JSON.stringify({ growth, growthPct: pct(N26, N23).toFixed(2), gap, zones: zones.map((x) => `${x.z} ${p1(x.g)}`), top: top.map((r) => `${r.state} ${p1(r.g)}`), topShare: topShare.toFixed(1), stateGrowth: `${byGrowth[0].state} ${p1(byGrowth[0].g)} … ${byGrowth.at(-1).state} ${p1(byGrowth.at(-1).g)}`, checks }));
if (Object.values(checks).some((ok) => !ok)) throw new Error("published aggregates do not add up; stop and re-check sources");

// ---- charts (inline SVG; neutral palette: 2023 grey, 2026 bronze; not party data) ----
const C23 = "#A8A39A", C26 = "#B4501F", INK = "#0D0E10", MUTED = "#5B5F67";
function hbars(rows, { label, a, b, max, w = 640, rowH = 34, fmt = nf.format, right }) {
  const L = 170, R = 130, H = rows.length * rowH + 30, bw = w - L - R;
  const bars = rows.map((r, i) => {
    const y = 20 + i * rowH;
    const x23 = b ? `<rect x="${L}" y="${y}" width="${(r[b] / max) * bw}" height="10" fill="${C23}"/>` : "";
    const x26 = `<rect x="${L}" y="${y + (b ? 12 : 4)}" width="${(r[a] / max) * bw}" height="${b ? 12 : 16}" fill="${C26}"/>`;
    return `<text x="${L - 8}" y="${y + 15}" text-anchor="end" font-size="12" fill="${INK}">${esc(r[label])}</text>${x23}${x26}<text x="${L + (r[a] / max) * bw + 6}" y="${y + (b ? 22 : 16)}" font-size="11" fill="${INK}">${esc(fmt(r[a]))}</text>${right ? `<text x="${w - 4}" y="${y + 18}" text-anchor="end" font-size="12" font-weight="700" fill="${INK}">${esc(right(r))}</text>` : ""}`;
  }).join("");
  const legend = b ? `<rect x="${L}" y="2" width="10" height="10" fill="${C23}"/><text x="${L + 14}" y="11" font-size="11" fill="${MUTED}">2023</text><rect x="${L + 60}" y="2" width="10" height="10" fill="${C26}"/><text x="${L + 74}" y="11" font-size="11" fill="${MUTED}">2026 (preliminary)</text>` : "";
  return `<svg viewBox="0 0 ${w} ${H}" width="100%" role="img" aria-label="bar chart">${legend}${bars}</svg>`;
}
const zoneChart = hbars(zones, { label: "name", a: "v26", b: "v23", max: 26e6, right: (r) => p1(r.g) });
const topChart = hbars(top, { label: "state", a: "2026", b: "2023", max: 8e6, right: (r) => p1(r.g) });
const ageRows = age.bands.map((x) => ({ band: x.band, v: x.pct }));
const ageChart = hbars(ageRows, { label: "band", a: "v", max: 50, fmt: (v) => `${v.toFixed(2)}%` });
const genderBar = `<svg viewBox="0 0 640 60" width="100%" role="img" aria-label="gender split"><rect x="0" y="10" width="${6.4 * g.malePct}" height="26" fill="${C26}"/><rect x="${6.4 * g.malePct}" y="10" width="${6.4 * g.femalePct}" height="26" fill="${C23}"/><text x="8" y="28" font-size="12" fill="#fff" font-weight="700">Male ${g.malePct}% · ${nf.format(g.male)}</text><text x="632" y="28" text-anchor="end" font-size="12" fill="${INK}" font-weight="700">Female ${g.femalePct}% · ${nf.format(g.female)}</text></svg>`;

// ---- risk matrix (data handling) ----
const risks = [
  ["Storing or redistributing voter records (names, VINs, photos)", "Low (policy forbids it)", "Severe", "Never collected; no lookup; no scraper; reviewed in every session"],
  ["Scraping display.inecnigeria.org", "Low (rejected)", "Severe", "Rejected: personal and sensitive data behind sign-in and view limits"],
  ["Repeating unverified fraud claims", "Medium", "High", "Only INEC statements and named press reports; label 'unverified'; no party attributions"],
  ["Using preliminary totals as election-day baselines", "Medium", "High", "Baselines switch to the final register (15 Dec 2026); preliminary figures labelled"],
  ["Transcription errors from press reports", "Medium", "Medium", "Totals cross-checked (zones, gender and all 37 states sum to 103,428,715; each zone's states sum to its total); state table marked unverified"],
  ["Users sharing others' register entries via Binchika", "Low", "High", "Page asks people not to share; Binchika accepts no register screenshots"],
  ["Linking to the official portal", "Low", "Low", "Link only; neutral wording; no claims about the portal's accuracy"],
];
const lvl = (s) => (/Severe|High/.test(s) ? "hi" : /Medium/.test(s) ? "md" : "lo");

const srcList = [...new Set([...S.sources2026, ...(S.corroboratedBy ?? []), ...(A.claimsObjections?.sources ?? []), A.national.source2023, ...A.national.sources2026, ...A.zones.sources2026, ...A.topStates.sources2026, ...A.gender2026.sources, ...A.age2026.sources])];

// ---- markdown source ----
const md = `# INEC preliminary register 2027: executive summary

_Binchika · ${A.compiled} · aggregate figures only (no individual records). Status: ${A.status}_

## Key findings
1. **The register grew by ${(growth / 1e6).toFixed(2)} million (${p1(pct(N26, N23))}) to ${nf.format(N26)}.** That is ${nf.format(gap)} less than the ${nf.format(NEW)} new registrations recorded. INEC has not said what the gap consists of, so it is **not** a count of removals.
2. **The North-West is the largest zone and grew fastest (${p1(zones[0].g)}).** The South-West grew slowest (${p1(zones.find((x) => x.z === "SW").g)}). Every zone grew by at least 9%.
3. **The ten largest states hold ${topShare.toFixed(1)}% of voters.** Ogun (${p1(top.find((r) => r.state === "Ogun").g)}) and Kano (${p1(top.find((r) => r.state === "Kano").g)}) grew fastest among them; Lagos grew ${p1(top.find((r) => r.state === "Lagos").g)}.
4. **Voters aged 18–34 are now ${age.bands[0].pct}%, down from ${age.youthShare2023Pct}% in 2023.** Voters aged 35–49 are the largest group (${age.bands[1].pct}%).
5. **Men are ${g.malePct}% of the register and women ${g.femalePct}%.**
6. **INEC is investigating data quality.** It has flagged questionable records and suspected AI-generated photos. The final register, due 15 December 2026, should be the only basis for election-day checks.

## Zones (2023 → 2026)
| Zone | 2023 | 2026 | Change |
|---|---:|---:|---:|
${zones.map((x) => `| ${x.name} | ${nf.format(x.v23)} | ${nf.format(x.v26)} | ${p1(x.g)} |`).join("\n")}
| **Nigeria** | **${nf.format(N23)}** | **${nf.format(N26)}** | **${p1(pct(N26, N23))}** |

## Ten largest states
| State | 2023 | 2026 | Change |
|---|---:|---:|---:|
${top.map((r) => `| ${r.state} | ${nf.format(r["2023"])} | ${nf.format(r["2026"])} | ${p1(r.g)} |`).join("\n")}

## All 37 states (press-reported, not yet confirmed against an INEC document)
_${S.status}_

| State | Zone | 2023 | 2026 | Change |
|---|---|---:|---:|---:|
${states.map((r) => `| ${r.state} | ${r.zone} | ${nf.format(r["2023"])} | ${nf.format(r["2026"])} | ${p1(r.g)} |`).join("\n")}

${S.notes.map((n) => `- ${n}`).join("\n")}
- Growth across the 37 ranged from ${p1(byGrowth.at(-1).g)} (${byGrowth.at(-1).state}) to ${p1(byGrowth[0].g)} (${byGrowth[0].state}).
- **Still unpublished (${A.compiled}):** INEC's own state-by-state document, LGA totals, and counts of claims and objections.

## Age and gender (2026)
| Age band | Share | Voters |
|---|---:|---:|
${age.bands.map((x) => `| ${x.band} | ${x.pct}% | ${x.count ? nf.format(x.count) : "not published"} |`).join("\n")}

Male ${nf.format(g.male)} (${g.malePct}%) · Female ${nf.format(g.female)} (${g.femalePct}%).

## Data-handling risk matrix
| Risk | Likelihood | Impact | Control |
|---|---|---|---|
${risks.map((r) => `| ${r.join(" | ")} |`).join("\n")}

## Method and limits
- 2026 figures are INEC's announcement of 6 October 2026, as reported by the press. INEC's own state-by-state document was not found online; the 37-state table comes from a press report and is marked unverified.
- The 2023 figures come from INEC's official PDF, with its hash recorded.
- Zone totals for 2023 are summed from the state table.
- The zone and gender figures each add up exactly to the national total, and each zone's 2026 state figures add up exactly to that zone's total.
- No claims-and-objections counts had been published.
- Detail and every URL: \`docs/INEC-PRELIMINARY-REGISTER-2027.md\`.

## Sources
${srcList.map((u) => `- ${u}`).join("\n")}
`;
writeFileSync(`${OUT}/inec-register-2027-summary.md`, md);

// ---- HTML → PDF ----
const kpi = (v, l) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>INEC preliminary register 2027: executive summary</title><style>
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 10.5pt/1.45 "Segoe UI", Arial, sans-serif; color: ${INK}; margin: 0; }
h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: -.01em; } h2 { font-size: 12.5pt; margin: 7mm 0 2mm; border-top: 2px solid ${C26}; padding-top: 2mm; }
.sub { color: ${MUTED}; font-size: 9pt; margin-bottom: 4mm; } .src { color: ${MUTED}; font-size: 7.5pt; margin-top: 1mm; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin: 3mm 0 4mm; } .kpi { border: 1px solid #E1DCD1; border-radius: 3mm; padding: 2.5mm 3mm; } .kpi b { display: block; font-size: 15pt; color: ${C26}; } .kpi span { font-size: 8pt; color: ${MUTED}; }
ol.find li { margin-bottom: 1.6mm; } .page { page-break-before: always; }
table { border-collapse: collapse; width: 100%; font-size: 8.8pt; } th, td { border-bottom: 1px solid #E6E2D8; padding: 1.6mm 2mm; text-align: left; vertical-align: top; } th { background: #F3F1EC; }
.hi { background: #F6D5D1; } .md { background: #FBEBC8; } .lo { background: #DDEFE3; }
.note { background: #F6F5F1; border-left: 3px solid ${C26}; padding: 2mm 3mm; font-size: 8.8pt; }
</style></head><body>
<h1>INEC's preliminary register: ${(N26 / 1e6).toFixed(1)} million voters, growth led by the North, and a shrinking youth share</h1>
<div class="sub">Binchika · executive summary · ${A.compiled} · aggregate figures only; no individual voter data was collected · ${esc(A.status)}</div>
<div class="kpis">${kpi(nf.format(N26), "registered voters (preliminary)")}${kpi(p1(pct(N26, N23)), "growth since 2023")}${kpi(`${age.bands[0].pct}%`, `aged 18–34 (${age.youthShare2023Pct}% in 2023)`)}${kpi("15 Dec 2026", "final register due")}</div>
<h2>Executive findings</h2>
<ol class="find">
<li><b>The register grew by ${(growth / 1e6).toFixed(2)} m (${p1(pct(N26, N23))}).</b> That is ${nf.format(gap)} below the ${nf.format(NEW)} new registrations. INEC has not said what makes up the gap, so it is not a removals count.</li>
<li><b>The North-West is the largest zone (${nf.format(zones[0].v26)}) and grew fastest (${p1(zones[0].g)}).</b> Every zone grew by at least 9%.</li>
<li><b>The ten largest states hold ${topShare.toFixed(1)}% of voters.</b> Ogun and Kano grew fastest among them; Rivers (${p1(top.find((r) => r.state === "Rivers").g)}) and Lagos (${p1(top[0].g)}) grew slowest.</li>
<li><b>Young voters (18–34) fell from ${age.youthShare2023Pct}% to ${age.bands[0].pct}% of the register.</b> INEC has given no explanation.</li>
<li><b>INEC is reviewing questionable records and suspected AI-generated photos.</b> Only the final register (15 Dec) should anchor election-day checks.</li>
</ol>
<div class="note">Binchika links citizens to INEC's own portal (display.inecnigeria.org) to check their names. It never stores, searches or redistributes voter records, VINs or photographs.</div>
<h2>Every zone grew by at least 9%; the North-West added the most voters</h2>
${zoneChart}
<div class="src">Registered voters by geopolitical zone, 2023 vs 2026. 2026: INEC announcement, 6 Oct 2026, as reported (zones sum to ${nf.format(N26)}). 2023: INEC official PDF, summed by state.</div>
<div class="page"></div>
<h2>Among the ten largest states, growth ranged from 5.6% (Rivers) to 13.0% (Ogun)</h2>
${topChart}
<div class="src">Ten largest states by 2026 register. All 37 are listed on the last page. Still unpublished: INEC's own state-by-state document, LGA totals and claims-and-objections counts.</div>
<h2>Voters aged 35–49 are now the largest group; the 18–34 share has fallen sharply</h2>
${ageChart}
<div class="src">Share of the 2026 register by age band. 18–34 was ${age.youthShare2023Pct}% in 2023.</div>
<h2>The gender split is close to even</h2>
${genderBar}
<div class="page"></div>
<h2>Data-handling risk matrix: Binchika publishes aggregates and links, never records</h2>
<table><thead><tr><th>Risk</th><th>Likelihood</th><th>Impact</th><th>Control</th></tr></thead><tbody>
${risks.map((r) => `<tr><td>${esc(r[0])}</td><td class="${lvl(r[1])}">${esc(r[1])}</td><td class="${lvl(r[2])}">${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join("")}
</tbody></table>
<div class="page"></div>
<h2>All 37 states: growth ranged from ${p1(byGrowth.at(-1).g)} (${esc(byGrowth.at(-1).state)}) to ${p1(byGrowth[0].g)} (${esc(byGrowth[0].state)})</h2>
<div class="note">Press-reported table, not yet confirmed against an INEC document. Every zone's states add up exactly to INEC's announced zone total, and all 37 to ${nf.format(N26)}. Use the final register (15 Dec 2026) for any baseline.</div>
<table style="margin-top:2mm"><thead><tr><th>State</th><th>Zone</th><th style="text-align:right">2023</th><th style="text-align:right">2026</th><th style="text-align:right">Change</th></tr></thead><tbody>
${states.map((r) => `<tr><td>${esc(r.state)}</td><td>${esc(r.zone)}</td><td style="text-align:right">${nf.format(r["2023"])}</td><td style="text-align:right">${nf.format(r["2026"])}</td><td style="text-align:right">${p1(r.g)}</td></tr>`).join("")}
</tbody></table>
<div class="src">${S.notes.map(esc).join(" ")}</div>
<h2>Method and sources</h2>
<p style="font-size:9pt">Arithmetic on published aggregates only. The zone and gender totals were checked to sum to the national total, and each zone's state figures to that zone's total. No claims-and-objections counts were published by ${A.compiled}. The full research, with every URL, is in docs/INEC-PRELIMINARY-REGISTER-2027.md. Binchika is a citizen transparency layer; only INEC declares results.</p>
<ul style="font-size:7.8pt;color:${MUTED}">${srcList.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
</body></html>`;
writeFileSync(`${OUT}/inec-register-2027-summary.html`, html);

const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "load" });
await page.pdf({ path: `${OUT}/inec-register-2027-summary.pdf`, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: `<div style="font-size:7pt;color:#6B6F76;width:100%;padding:0 15mm;display:flex;justify-content:space-between"><span>Binchika · INEC preliminary register 2027 · aggregates only</span><span class="pageNumber"></span></div>`, margin: { top: "16mm", bottom: "18mm", left: "15mm", right: "15mm" } });
await browser.close();
console.log(`wrote ${OUT}/inec-register-2027-summary.{md,html,pdf}`);
