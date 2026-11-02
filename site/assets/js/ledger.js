// Live ledger dashboard: polling, filters, sort, CSV, in-browser chain verification, clearly-labelled demo data.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
import { verifyChain, makeEntry, genesis } from "./lib/ledger.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-GB");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wat = new Intl.DateTimeFormat("en-GB", { timeZone: TENANT.locale.timeZone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const [meta, parties] = await Promise.all([fetch("/data/states.json").then((r) => r.json()), fetch("/data/parties.json").then((r) => r.json())]);
const stateName = Object.fromEntries(meta.states.map((s) => [s.iso, s.short ?? s.name]));
const colour = Object.fromEntries(parties.parties.map((p, i) => [p.acronym, parties.palette[i]]));
const CODE = TENANT.pollingUnits.statePrefix;
for (const s of [...meta.states].sort((a, b) => a.name.localeCompare(b.name))) $("f-state").add(new Option(s.name, s.iso));

let entries = [];
let gen = null;
let demo = false;
let sort = { key: "seq", dir: -1 };

const total = (t) => Object.values(t ?? {}).reduce((a, v) => a + v, 0);
const lead = (t) => Object.entries(t ?? {}).sort((a, b) => b[1] - a[1])[0];
// Demo rows are never attached to a real state, so a screenshot cannot pass as real results.
const stateOf = (e) => (e.pu_code?.startsWith("DEMO") ? null : CODE[e.pu_code?.slice(0, 2)] ?? null);

async function load() {
  if (demo) return;
  try {
    let after = entries.at(-1)?.seq ?? 0;
    for (let i = 0; i < 20; i++) {
      const page = await fetch(`/api/ledger?after=${after}&limit=1000`).then((r) => r.json());
      gen = page.genesis;
      entries.push(...page.entries);
      if (page.entries.length < 1000) break;
      after = page.entries.at(-1).seq;
    }
    render();
  } catch { $("ledger-body").innerHTML = `<tr><td colspan="11">The ledger could not be loaded. Retrying…</td></tr>`; }
}

function filtered() {
  const race = $("f-race").value, st = $("f-state").value, kind = $("f-kind").value, q = $("f-q").value.trim().toLowerCase();
  return entries.filter((e) =>
    (!race || e.race === race) && (!st || stateOf(e) === st) &&
    (!kind || (kind === "disc" ? e.discrepancy && !e.discrepancy.match : e.kind === kind)) &&
    (!q || e.pu_code.toLowerCase().includes(q) || e.hash.startsWith(q)));
}

function render() {
  const rows = filtered().sort((a, b) => {
    const v = (e) => (sort.key === "total" ? total(e.tally) : e[sort.key]);
    return (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * sort.dir;
  });
  const units = new Set(entries.filter((e) => e.kind === "tally").map((e) => e.pu_code + e.race));
  $("k-entries").textContent = nf.format(entries.length);
  $("k-high").textContent = nf.format(units.size);
  $("k-disc").textContent = nf.format(entries.filter((e) => e.discrepancy && !e.discrepancy.match).length);
  $("k-states").textContent = nf.format(new Set(entries.map(stateOf).filter(Boolean)).size);
  if (!rows.length) {
    $("ledger-body").innerHTML = `<tr><td colspan="11" style="white-space:normal;padding:1.5rem">${entries.length ? "No entries match these filters." : `<strong>0 entries.</strong> No votes have been cast yet. The ledger opens on election day. Genesis hash: <span class="hash">${esc(gen ?? "")}</span>`}</td></tr>`;
    return;
  }
  $("ledger-body").innerHTML = rows.slice(0, 2000).map((e) => {
    const l = lead(e.tally);
    const disc = e.discrepancy ? (e.discrepancy.match ? `<span class="chip ok"><i></i>Match</span>` : `<span class="chip bad"><i></i>${e.discrepancy.diffs.length} differ</span>`) : `<span class="chip"><i></i>No upload yet</span>`;
    const conf = e.kind === "correction" ? `<span class="chip warn"><i></i>Correction</span>` : `<span class="chip ok"><i></i>High · ${Math.round((e.consensus?.share ?? 0) * 100)}% of ${e.consensus?.reports ?? 0}</span>`;
    return `<tr data-seq="${e.seq}" tabindex="0" style="cursor:pointer">
      <td class="num">${e.seq}</td><td>${e.kind === "correction" ? "Correction" : "Tally"}</td><td class="mono">${esc(e.pu_code)}</td>
      <td>${e.pu_code.startsWith("DEMO") ? "<em>Demo</em>" : esc(stateName[stateOf(e)] ?? "—")}</td><td>${esc(e.race)}</td><td>${conf}</td>
      <td>${l ? `<span class="zone-swatch" style="background:${colour[l[0]] ?? "#888"}"></span><strong class="mono">${esc(l[0])}</strong> ${nf.format(l[1])}` : "—"}</td>
      <td class="num">${nf.format(total(e.tally))}</td><td>${disc}</td><td>${wat.format(new Date(e.recordedAt))}</td><td class="hash">${esc(e.hash.slice(0, 12))}…</td></tr>`;
  }).join("");
}

function openEntry(seq) {
  const e = entries.find((x) => x.seq === Number(seq));
  if (!e) return;
  $("entry-title").textContent = `#${e.seq} · ${e.pu_code} · ${e.race}`;
  const diffs = e.discrepancy?.diffs?.length ? `<table class="data" style="margin:.5rem 0"><thead><tr><th>Party</th><th class="num">Citizen</th><th class="num">IReV</th><th class="num">Δ</th></tr></thead><tbody>${e.discrepancy.diffs.map((d) => `<tr><td class="mono">${esc(d.party)}</td><td class="num">${d.citizen}</td><td class="num">${d.official}</td><td class="num">${d.delta > 0 ? "+" : ""}${d.delta}</td></tr>`).join("")}</tbody></table>` : "";
  $("entry-body").innerHTML = `${diffs}<p class="hash" style="word-break:break-all">prev ${esc(e.prev)}<br>hash ${esc(e.hash)}</p><pre class="code" tabindex="0">${esc(JSON.stringify(e, null, 2))}</pre>`;
  $("entry-dialog").showModal();
}

$("ledger-body").addEventListener("click", (ev) => { const tr = ev.target.closest("tr[data-seq]"); if (tr) openEntry(tr.dataset.seq); });
$("ledger-body").addEventListener("keydown", (ev) => { if (ev.key === "Enter") { const tr = ev.target.closest("tr[data-seq]"); if (tr) openEntry(tr.dataset.seq); } });
["f-race", "f-state", "f-kind", "f-q"].forEach((id) => $(id).addEventListener("input", render));
document.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => {
  sort = { key: b.dataset.sort, dir: sort.key === b.dataset.sort ? -sort.dir : -1 };
  render();
}));

$("verify").addEventListener("click", async () => {
  const out = $("verify-out");
  out.textContent = "Verifying…";
  const t0 = performance.now();
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const r = await verifyChain(ordered, gen ?? (await genesis("ng-2027")));
  out.innerHTML = r.ok
    ? `<strong style="color:var(--ok)">Chain intact.</strong> ${nf.format(ordered.length)} entries re-hashed in your browser in ${Math.round(performance.now() - t0)} ms. Head: <span class="hash">${esc(ordered.at(-1)?.hash ?? gen)}</span>`
    : `<strong style="color:var(--bad)">Chain broken at entry #${ordered[r.brokenAt].seq}.</strong> Please <a href="/contact/?topic=error">report it</a>.`;
});

$("csv").addEventListener("click", () => {
  const rows = filtered();
  const allParties = [...new Set(rows.flatMap((e) => Object.keys(e.tally ?? {})))].sort();
  const head = ["seq", "kind", "pu_code", "state", "race", "share", "reports", ...allParties, "irev_match", "recorded_at", "hash", "prev"];
  const lines = [head.join(","), ...rows.map((e) => [e.seq, e.kind, e.pu_code, stateOf(e) ?? "", e.race, e.consensus?.share ?? "", e.consensus?.reports ?? "", ...allParties.map((p) => e.tally?.[p] ?? 0), e.discrepancy ? e.discrepancy.match : "", e.recordedAt, e.hash, e.prev].join(","))];
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })), download: `binchika-ledger${demo ? "-DEMO" : ""}-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
});

// Demo: fictional parties DEMO-A…D and PU codes DEMO-…, chained with the real ledger code.
$("demo").addEventListener("click", async () => {
  demo = !demo;
  $("demo").setAttribute("aria-pressed", String(demo));
  $("demo-banner").hidden = !demo;
  $("live").hidden = demo;
  entries = [];
  if (!demo) { gen = null; await load(); return; }
  gen = await genesis("demo");
  const P = ["DEMOA", "DEMOB", "DEMOC", "DEMOD"];
  P.forEach((p, i) => (colour[p] = ["#1559D6", "#0F8A5F", "#B26B00", "#8B3FB0"][i]));
  let prev = gen;
  for (let i = 1; i <= 160; i++) {
    const tally = Object.fromEntries(P.map((p) => [p, Math.floor(Math.random() * 300)]));
    const mismatch = Math.random() < 0.12;
    const official = mismatch ? { ...tally, DEMOA: tally.DEMOA + 25 } : tally;
    const diffs = mismatch ? [{ party: "DEMOA", citizen: tally.DEMOA, official: official.DEMOA, delta: -25 }] : [];
    const e = await makeEntry({ seq: i, kind: i % 37 === 0 ? "correction" : "tally", pu_code: `DEMO-${String(i % 37).padStart(2, "0")}-${String(i).padStart(4, "0")}`, race: i % 3 ? "president" : "governor", consensus: { status: "high", share: 0.85 + Math.random() * 0.15, reports: 3 + Math.floor(Math.random() * 9) }, tally, official: { source: "DEMO", tally: official }, discrepancy: { match: !mismatch, diffs } }, prev, new Date(Date.now() - (160 - i) * 47000).toISOString());
    entries.push(e);
    prev = e.hash;
  }
  render();
});

await load();
setInterval(load, 15000);
