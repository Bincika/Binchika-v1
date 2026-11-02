// Pre-election baselines: downloads official INEC PDFs, stores them raw with a fetch timestamp and SHA-256,
// extracts registered-voter figures, and writes site/data/baselines/registered-voters.json.
// Every number carries its source URL, document hash and fetch time. Re-run anytime; history is kept.
// Usage: node scripts/fetch-inec-baselines.mjs [--dump <docId>]
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { extractText, getDocumentProxy } = await import("unpdf");

const DOCS = [
  { id: "2023-state-register", level: "state", url: "https://www.inecnigeria.org/wp-content/uploads/2023/02/PVCs-Collected-Registered-Voters.pdf", title: "Registered Voters & PVCs Collected for the 2023 General Election" },
  { id: "2023-delim-bayelsa-imo-kogi", level: "lga", url: "https://inecnigeria.org/wp-content/uploads/2023/11/DELIMITATION-DATA-FOR-BAYELSA-IMO-KOGI-ELECTION.pdf", title: "Delimitation data: Bayelsa, Imo and Kogi governorship elections (Nov 2023)" },
];
const RAW = "data/raw/inec/baselines";
await mkdir(RAW, { recursive: true });
await mkdir("site/data/baselines", { recursive: true });
const states = JSON.parse(await readFile("site/data/states.json", "utf8")).states;
const isoByName = Object.fromEntries(states.map((s) => [s.name.toUpperCase(), s.iso]).concat([["FCT", "NG-FC"], ["ABUJA", "NG-FC"], ["FCT ABUJA", "NG-FC"], ["AKWA-IBOM", "NG-AK"], ["CROSS-RIVER", "NG-CR"], ["NASSARAWA", "NG-NA"]]));
const num = (s) => Number(String(s).replace(/,/g, ""));

const out = { generatedAt: new Date().toISOString(), documents: [], state: {}, lga: {} };
for (const d of DOCS) {
  // INEC moved off WordPress in 2026; fall back to the Internet Archive copy of the same INEC URL.
  const UA = { headers: { "user-agent": "BinchikaDataBuild/1.0 (+https://binchika.com)" } };
  let res = await fetch(d.url, UA);
  let via = d.url;
  if (!res.ok) {
    const avail = await (await fetch("https://archive.org/wayback/available?url=" + encodeURIComponent(d.url), UA)).json().catch(() => null);
    const snap = avail?.archived_snapshots?.closest;
    if (snap?.available) { via = snap.url.replace(/\/web\/(\d+)\//, "/web/$1id_/"); res = await fetch(via, UA); }
  }
  if (!res.ok) { console.log("skip", d.id, res.status); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const fetchedAt = new Date().toISOString();
  await writeFile(`${RAW}/${d.id}.pdf`, buf);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  await writeFile(`${RAW}/${d.id}.txt`, text);
  out.documents.push({ id: d.id, title: d.title, url: d.url, retrievedFrom: via, sha256, fetchedAt, bytes: buf.length, level: d.level });
  if (process.argv.includes("--dump") && process.argv.includes(d.id)) console.log(text.slice(0, 3000));

  const src = { doc: d.id, url: d.url, retrievedFrom: via, sha256, fetchedAt };
  if (d.level === "state") {
    // rows look like: "<n> <STATE NAME> <registered> <pvcs collected> <pct>%"
    const re = /\b\d{1,2}\s+([A-Z][A-Z .\-]+?)\s+([\d,]{6,})\s+([\d,]{5,})\s+([\d.]+)\s*%/g;
    for (const m of text.toUpperCase().matchAll(re)) {
      const iso = isoByName[m[1].trim()];
      if (iso) out.state[iso] = { registered: num(m[2]), pvcCollected: num(m[3]), ...src };
    }
  } else {
    // Delimitation booklets: each state has a chart block "…<registered> <LGA NAME> <registered> <LGA NAME>…
    // Registered Voters … Registered Voters by Local Government". Values precede names (checked: the sums equal
    // INEC's state totals, and the capital LGA comes out largest). A state is accepted only if its LGAs sum exactly
    // to the state register total.
    const pages = text.replace(/([A-Z])(\d)/g, "$1 $2").split(/DELIMITATION DATA\s*\d+/);
    for (const page of pages) {
      if (!/Registered Voters by Local Government/i.test(page) || /PVCs Collected by Local Government/i.test(page)) continue;
      const stateName = (page.toUpperCase().match(/\b(ABIA|ADAMAWA|AKWA IBOM|ANAMBRA|BAUCHI|BAYELSA|BENUE|BORNO|CROSS RIVER|DELTA|EBONYI|EDO|EKITI|ENUGU|GOMBE|IMO|JIGAWA|KADUNA|KANO|KATSINA|KEBBI|KOGI|KWARA|LAGOS|NASARAWA|NIGER|OGUN|ONDO|OSUN|OYO|PLATEAU|RIVERS|SOKOTO|TARABA|YOBE|ZAMFARA|FCT)\b/) ?? [])[1];
      const iso = isoByName[stateName];
      if (!iso) continue;
      // drop legend/total text and the state label; what remains is "<registered> <LGA>" pairs in any order
      const body = page.toUpperCase()
        .replace(/REGISTERED VOTERS BY LOCAL GOVERNMENT|PUS WITH NO REGISTERED VOTERS|REGISTERED VOTERS|PVCS COLLECTED/g, " | ")
        .split("|").filter((chunk) => /[A-Z]{3}/.test(chunk) && /\d{1,3},\d{3}/.test(chunk)).join(" ")
        .replace(new RegExp(`^\\s*${stateName}\\b`), " ").replace(new RegExp(`(\\d)\\s+${stateName}\\s+(?=[A-Z])`), "$1 ");
      const rows = {};
      for (const m of body.matchAll(/([\d]{1,3}(?:,\d{3})+)\s+([A-Z][A-Z/'.\- ]*?[A-Z.])(?=\s+\d|\s*$)/g)) {
        const name = m[2].replace(/\s*\/\s*/g, "/").replace(/\s*\.\s*/g, ".").replace(/\s+/g, " ").replace(/\.$/, "").trim();
        rows[name] = num(m[1]);
      }
      const sum = Object.values(rows).reduce((a, v) => a + v, 0);
      const expected = out.state[iso]?.registered;
      const ok = expected === sum;
      console.log(stateName, Object.keys(rows).length, "LGAs, sum", sum, ok ? "= state total ✓" : `≠ state total ${expected} ✗ (rejected)`);
      if (!ok) continue;
      out.lga[iso] = Object.fromEntries(Object.entries(rows).map(([name, registered]) => [name, { registered, ...src }]));
    }
  }
}
// Link each LGA baseline to its GRID3 polygon name so the map can show it.
const { lgaKey } = await import("../functions/_lib/baseline.js");
const lgaTopo = JSON.parse(await readFile("site/data/geo/ng-lgas.topo.json", "utf8"));
const gridNames = Object.values(lgaTopo.objects)[0].geometries.map((g) => g.properties);
for (const [iso, lgas] of Object.entries(out.lga)) {
  for (const [name, rec] of Object.entries(lgas)) {
    const hit = gridNames.find((g) => g.stateIso === iso && lgaKey(g.name) === lgaKey(name));
    rec.grid3 = hit?.name ?? null;
    if (!hit) console.log("unmatched LGA", iso, name);
  }
}
const stateCount = Object.keys(out.state).length;
const lgaCount = Object.values(out.lga).reduce((a, o) => a + Object.keys(o).length, 0);
out.coverage = { states: stateCount, lgas: lgaCount, note: "LGA-level figures exist only where INEC has published a delimitation booklet. Others are pending, not estimated." };
// keep history of every pull
const histPath = "data/raw/inec/baselines/history.jsonl";
await writeFile(histPath, JSON.stringify({ at: out.generatedAt, documents: out.documents.map(({ id, sha256 }) => ({ id, sha256 })), states: stateCount, lgas: lgaCount }) + "\n", { flag: "a" });
await writeFile("site/data/baselines/registered-voters.json", JSON.stringify(out, null, 1));
const total = Object.values(out.state).reduce((a, s) => a + s.registered, 0);
console.log(JSON.stringify({ states: stateCount, stateTotal: total, lgas: lgaCount, lgaByState: Object.fromEntries(Object.entries(out.lga).map(([k, v]) => [k, Object.keys(v).length])) }));
