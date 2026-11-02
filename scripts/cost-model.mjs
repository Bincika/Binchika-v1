// Evidence-storage cost model for one general-election cycle (two election days), 12-month retention.
// Prices: 2026 list prices from secondary sources (see docs/protocol/EVIDENCE-STORAGE-AND-COSTS.md) —
// re-verify on vendor pages before budgeting. Usage: node scripts/cost-model.mjs  (prints markdown)

const PU = 176846, REGISTERED = 93469008;
const SHEETS_PER_PU = 5;            // President, Senate, House (day 1) + Governor, State Assembly (day 2) — upper bound
const MB_FULL = 0.30, MB_THUMB = 0.03; // client-compressed EC8A (~1600 px WebP) + 480 px thumbnail
const MONTHS = 12;                   // keep evidence through tribunal/appeal windows
const VIEWS_PER_PHOTO = 20, FULL_VIEW_SHARE = 0.1;

const SCENARIOS = [
  { id: "target", label: "Target: 3 independent photos per result sheet", photos: PU * SHEETS_PER_PU * 3 },
  { id: "heavy", label: "Heavy: 10 photos per result sheet", photos: PU * SHEETS_PER_PU * 10 },
  { id: "everyone", label: "Every registered voter sends 1 photo per election day, +25% overrun", photos: Math.round(REGISTERED * 2 * 1.25) },
  { id: "95m-x3", label: "~95 million registered voters × 3 photos each", photos: 95_000_000 * 3 },
];

const tiered = (gb, tiers) => { let left = gb, cost = 0; for (const [size, price] of tiers) { const take = Math.min(left, size); cost += take * price; left -= take; if (left <= 0) break; } return cost; };
const PROVIDERS = {
  "Cloudflare R2": { storage: 0.015, putPerM: 4.5, getPerM: 0.36, egress: () => 0, free: { gb: 10, putM: 1, getM: 10 } },
  "AWS S3 Standard": { storage: 0.023, putPerM: 5.0, getPerM: 0.4, egress: (gb) => tiered(Math.max(0, gb - 100), [[10240, 0.09], [40960, 0.085], [102400, 0.07], [Infinity, 0.05]]) },
  "Azure Blob Hot (LRS)": { storage: 0.018, putPerM: 6.5, getPerM: 0.5, egress: (gb) => tiered(Math.max(0, gb - 100), [[10240, 0.087], [40960, 0.083], [Infinity, 0.07]]) },
  "Google Cloud Storage Standard": { storage: 0.020, putPerM: 5.0, getPerM: 0.4, egress: (gb) => tiered(gb, [[1024, 0.12], [9216, 0.11], [Infinity, 0.08]]) },
};

const usd = (n) => "$" + Math.round(n).toLocaleString("en-GB");
const rows = [];
for (const s of SCENARIOS) {
  const storedGB = (s.photos * (MB_FULL + MB_THUMB)) / 1024;
  const puts = s.photos * 2;
  const gets = s.photos * VIEWS_PER_PHOTO;
  const egressGB = (gets * (MB_THUMB + FULL_VIEW_SHARE * MB_FULL)) / 1024;
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const storage = Math.max(0, storedGB - (p.free?.gb ?? 0)) * p.storage * MONTHS;
    const ops = Math.max(0, puts / 1e6 - (p.free?.putM ?? 0)) * p.putPerM + Math.max(0, gets / 1e6 - (p.free?.getM ?? 0)) * p.getPerM;
    const egress = p.egress(egressGB);
    rows.push({ scenario: s.label, photos: s.photos, storedTB: storedGB / 1024, egressTB: egressGB / 1024, provider: name, storage, ops, egress, total: storage + ops + egress });
  }
}
console.log("| Scenario | Photos | Stored | Public egress | Provider | Storage (12 mo) | Requests | Egress | **Total** |");
console.log("|---|---:|---:|---:|---|---:|---:|---:|---:|");
for (const r of rows) console.log(`| ${r.scenario} | ${r.photos.toLocaleString("en-GB")} | ${r.storedTB.toFixed(1)} TB | ${r.egressTB.toFixed(1)} TB | ${r.provider} | ${usd(r.storage)} | ${usd(r.ops)} | ${usd(r.egress)} | **${usd(r.total)}** |`);
