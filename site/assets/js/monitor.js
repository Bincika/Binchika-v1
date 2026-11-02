// Live Tally Ledger (/tally/, formerly Election Monitor): race picker, threshold bar, state map with hover cards, road-to-victory panel, table fallback.
// Data: /api/results?race=… (high-confidence citizen tallies only). Demo (?demo=1): fictional parties, watermarked.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
import { feature } from "/assets/vendor/topojson.js";
import {resultsFeed} from './lib/results-feed.js?v=85';
import {eligibleStates,reportedSpread} from './lib/race-dashboard.js?v=85';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("en-GB");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const wat = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: TENANT.locale.timeZone, hour: "2-digit", minute: "2-digit" }) + ` ${TENANT.locale.zoneLabel}`;
const DEMO = new URLSearchParams(location.search).get("demo") === "1";

const TILE_BG = {
  president: "linear-gradient(135deg,#0D1B2E,#1559D6)", senate: "linear-gradient(135deg,#1B0D2E,#8B3FB0)", house: "linear-gradient(135deg,#0B1F16,#13946A)",
  governor: "linear-gradient(135deg,#24130A,#D4521C)", "state-assembly": "linear-gradient(135deg,#1E1A08,#B58A00)", "local-government": "linear-gradient(135deg,#0C1E22,#0E9AA0)",
};
const [{ races }, sTopo, meta, parties] = await Promise.all(["/data/races.json", "/data/geo/ng-states.topo.json", "/data/states.json", "/data/parties.json"].map((u) => fetch(u).then((r) => r.json())));
if(DEMO)meta.states.forEach((s,i)=>{s.name=`Demo area ${i+1}`;});
const info = Object.fromEntries(meta.states.map((s) => [s.iso, s]));
const colour = Object.fromEntries(parties.parties.map((p, i) => [p.acronym, parties.palette[i]]));
const states = feature(sTopo, Object.values(sTopo.objects)[0]);
states.features.forEach((f, i) => { f.id = i; f.properties.name = info[f.properties.iso].name; });
let race = new URLSearchParams(location.search).get("race") ?? "president";
if (!races[race]) race = "president";
let data = null, feedStatus='loading';
let selected = null;

// ---------- race picker: tiles + dropdown ----------
const pick = $("race-pick");
for (const [k, r] of Object.entries(races)) pick.add(new Option(r.label, k));
$("race-tiles").innerHTML = Object.entries(races).map(([k, r], i) => `<li><button class="race-tile" type="button" data-race="${k}" aria-pressed="false" style="--tile-bg:${TILE_BG[k]}"><span class="race-civic-art" aria-hidden="true"><svg viewBox="${(i % 3) * 512} ${Math.floor(i / 3) * 512} 512 512" preserveAspectRatio="xMidYMid slice"><image href="/assets/img/dashboard/nigerian-civic-art.webp" width="1536" height="1024"/></svg></span><b>${esc(r.label)}</b><span>${r.date ? new Date(r.date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Set by each state"}</span></button></li>`).join("");
document.querySelectorAll("[data-race]").forEach((b) => b.addEventListener("click", () => setRace(b.dataset.race)));
pick.addEventListener("change", () => setRace(pick.value));
function rebuildStatePick(){const areas=eligibleStates(race,meta.states,races);$("mon-state-pick").innerHTML='<option value="">All eligible areas…</option>';for(const s of [...areas].sort((a,b)=>a.name.localeCompare(b.name,'en-GB')))$("mon-state-pick").add(new Option(s.name,s.iso));if(selected&&!areas.some(s=>s.iso===selected))selected=null;$("mon-state-pick").value=selected??'';}
function selectState(iso,notify=true){selected=eligibleStates(race,meta.states,races).some(s=>s.iso===iso)?iso:null;$("mon-state-pick").value=selected??'';drawState();if(notify)window.dispatchEvent(new CustomEvent('binchika:state',{detail:selected}));}
$("mon-state-pick").addEventListener("change", (e) => selectState(e.target.value));

// ---------- demo data (fictional) ----------
if(DEMO)['ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT'].forEach((p,i)=>{colour[p]=['#1559D6','#C42B3C','#0F8A5F','#B26B00','#7A4FD0','#5E6B78'][i];});
function applyFeed(state){if(state.race!==race)return;data=state.data;feedStatus=state.status;$("mon-map").dataset.resultsVersion=state.revision??'';drawTally();drawRoad();drawLegend();drawTable();drawState();repaint();}

// ---------- tally bar ----------
function drawTally() {
  const r = races[race];
  $("race-title").textContent = r.label;
  $("race-rule").textContent = r.rule;
  const el = $("tally");
  if (race === "local-government") { el.innerHTML = `<div class="callout"><strong>Run by State Independent Electoral Commissions.</strong> Local government elections happen on dates each state sets. Binchika will add a state's LG results only where its SIEC publishes polling-unit results.</div>`; return; }
  if(!data){el.innerHTML=`<p class="source-note">${feedStatus==='loading'?'Loading the shared citizen-report snapshot…':'The reporting feed is unavailable. No vote totals are assumed.'}</p>`;return;}
  const totals = Object.entries(data?.national?.totals ?? {}).filter(([,votes])=>votes>0).sort((a, b) => b[1] - a[1]);
  const sum = totals.reduce((a, [, v]) => a + v, 0);
  if (r.unit === "votes") {
    const [a, b] = totals;
    // leader on the left, runner-up on the far right (matching the labels), everyone else between
    const ordered = totals.length > 2 ? [totals[0], ...totals.slice(2), totals[1]] : totals;
    const seg = ordered.map(([p, v]) => `<span style="width:${(100 * v) / sum}%;background:${colour[p] ?? "#888"}" title="${esc(p)} ${((100 * v) / sum).toFixed(1)}%"></span>`).join("");
    el.innerHTML = `<div class="tally-head"><div><div class="big">${a ? ((100 * a[1]) / sum).toFixed(1) + "%" : "0"}</div><div class="who">${a ? esc(a[0]) : "No votes counted yet"}</div></div>
      <div class="goal-label">25% spread reference: ${r.spreadGoal} of 36 states; FCT separately. INEC applies s.134.<br>▼</div>
      <div class="right"><div class="big">${b ? ((100 * b[1]) / sum).toFixed(1) + "%" : "0"}</div><div class="who">${b ? esc(b[0]) : "—"}</div></div></div>
      <div class="tally-bar" role="img" aria-label="Vote shares in the citizen count">${seg}<i class="goal" style="left:50%"></i></div>
      <div class="tally-notes"><span>${a ? `${nf.format(a[1])} votes · 25% in ${reportedSpread(data,eligibleStates(race,meta.states,races),a[0]).states} states${reportedSpread(data,eligibleStates(race,meta.states,races),a[0]).fct?' + FCT':''}` : "Counting starts 16 January 2027"}</span><span>${nf.format(data?.units?.reported ?? 0)} of ${nf.format(data?.units?.total ?? 176846)} polling units</span><span>${b ? `${nf.format(b[1])} votes · 25% in ${reportedSpread(data,eligibleStates(race,meta.states,races),b[0]).states} states${reportedSpread(data,eligibleStates(race,meta.states,races),b[0]).fct?' + FCT':''}` : ""}</span></div>`;
  } else {
    const total = r.unit === "states" ? 36 - (r.offCycle?.length ?? 0) : r.seats;
    const goal = r.majority ?? null;
    el.innerHTML = `<div class="tally-head"><div><div class="big">—</div><div class="who">${r.unit === "states" ? "State declarations unavailable" : "Seat allocations not connected"}</div></div>
      <div class="goal-label">${goal ? `${goal}: full-chamber majority reference` : race==='state-assembly'?'Current seat total unverified':`${total} scheduled states`}<br>▼</div>
      <div class="right"><div class="big">${total}</div><div class="who">${r.unit === "states" ? "states voting" : race==='state-assembly'?'2023 seat reference':'structural seats'}</div></div></div>
      <div class="tally-bar" role="img" aria-label="Sourced declarations are not connected">${goal ? `<i class="goal" style="left:${(100 * goal) / total}%"></i>` : ""}</div>
      <div class="tally-notes"><span>Sourced declarations are not connected; citizen vote shares never allocate seats.</span><span>${nf.format(data?.units?.reported ?? 0)} polling units in the citizen count</span></div>
      ${r.verified === false ? `<p class="source-note"><span class="flag-v">VERIFY</span> ${esc(r.offCycleNote ?? r.rule)}</p>` : ""}`;
  }
}

// ---------- map ----------
let map = null;
function fillExpr() {
  const r = races[race];
  const pairs = [];
  for (const f of states.features) {
    const iso = f.properties.iso;
    if (!eligibleStates(race,meta.states,races).some(s=>s.iso===iso)) { pairs.push(iso, css("--line-2") || "#999"); continue; }
    const l = data?.byState?.[iso]?.leader;
    if (l?.party) pairs.push(iso, colour[l.party] ?? "#64748b");
  }
  return pairs.length ? ["match", ["get", "iso"], ...pairs, css("--pending")] : css("--pending");
}
function initMap() {
  map = new window.maplibregl.Map({
    container: $("mon-map"),
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "rgba(0,0,0,0)" } }] },
    bounds: [[2.4, 4.0], [14.9, 14.1]], fitBoundsOptions: { padding: 24 },
    pitch: 0, bearing: 0, dragRotate: false, touchPitch: false, pitchWithRotate: false, cooperativeGestures: true,
    attributionControl: { compact: true, customAttribution: "GRID3 / geoBoundaries CC BY 4.0" },
  });
  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("load", () => {
    map.addSource("states", { type: "geojson", data: states });
    map.addLayer({ id: "fill", type: "fill", source: "states", paint: { "fill-color": fillExpr(), "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.88] } });
    map.addLayer({ id: "line", type: "line", source: "states", paint: { "line-color": css("--surface"), "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 3, 1.2] } });
    let hov = null;
    const card = $("hover-card");
    map.on("mousemove", "fill", (e) => {
      const f = e.features[0];
      if (hov !== null) map.setFeatureState({ source: "states", id: hov }, { hover: false });
      hov = f.id; map.setFeatureState({ source: "states", id: hov }, { hover: true });
      map.getCanvas().style.cursor = "pointer";
      card.innerHTML = cardHtml(f.properties.iso);
      const w = $("mon-map").clientWidth;
      card.style.left = Math.min(e.point.x + 16, w - 330) + "px";
      card.style.top = Math.max(8, e.point.y - 40) + "px";
      card.style.opacity = 1;
    });
    map.on("mouseleave", "fill", () => { if (hov !== null) map.setFeatureState({ source: "states", id: hov }, { hover: false }); hov = null; card.style.opacity = 0; map.getCanvas().style.cursor = ""; });
    map.on("click", "fill", (e) => selectState(e.features[0].properties.iso));
  });
}
function repaint() { if (map?.getLayer("fill")) map.setPaintProperty("fill", "fill-color", fillExpr()); }

function rows(iso) {
  const s = data?.byState?.[iso];
  const t = Object.entries(s?.totals ?? {}).sort((a, b) => b[1] - a[1]);
  const sum = t.reduce((a, [, v]) => a + v, 0);
  return { s, t, sum };
}
function cardHtml(iso) {
  const r = races[race];
  const name = info[iso].name;
  if(iso==='NG-FC'&&['governor','state-assembly','local-government'].includes(race))return `<h3>${esc(r.label)}: ${esc(name)}</h3><div class="foot"><span>${race==='local-government'?'FCT Area Council elections are a separate INEC event.':'The FCT does not hold a governorship or State House of Assembly election.'}</span></div>`;
  if (r.offCycle?.includes(iso)) return `<h3>${esc(r.label)}: ${esc(name)}</h3><div class="foot"><span>No governorship election on 6 Feb 2027 (off-cycle state)</span></div>`;
  if (race === "local-government") return `<h3>Local Government: ${esc(name)}</h3><div class="foot"><span>Run by ${esc(name)}'s SIEC</span></div>`;
  const { s, t, sum } = rows(iso);
  if (!t.length) return `<h3>${esc(r.label)}: ${esc(name)}</h3><div class="foot"><span>No citizen-verified units yet</span><span>${data?.updatedAt ? "Updated " + wat(data.updatedAt) : ""}</span></div>`;
  return `<h3>${esc(r.label)}: ${esc(name)}</h3>${t.slice(0, 4).map(([p, v]) => `<div class="row" style="${s.leader?.party === p ? "background:color-mix(in oklab," + (colour[p] ?? "#64748b") + " 12%,transparent)" : ""}"><i style="background:${colour[p] ?? "#64748b"}"></i><span><strong>${esc(p)}</strong>${s.leader?.party === p ? " <small>largest reported share</small>" : ""}</span><span style="text-align:right"><b>${sum?((100 * v) / sum).toFixed(1):'0.0'}%</b><small>${nf.format(v)}</small></span></div>`).join("")}
    <div class="foot"><span>Units reported: ${nf.format(s.units)}</span><span>Updated ${wat(data.updatedAt)}</span></div>`;
}

function drawState() {
  const p = $("mon-state");
  if (!selected) { p.innerHTML = `<h3>Choose a state</h3><p class="muted" style="margin:0">Tap the map or use the list below.</p>`; return; }
  p.innerHTML = `<div class="hover-card" style="position:static;opacity:1;box-shadow:none;max-width:none;border:0">${cardHtml(selected)}</div><p class="source-note">${esc(info[selected].lgas)} LGAs · ${info[selected].senate} senatorial districts · ${info[selected].house} federal constituencies</p>`;
}

function drawRoad() {
  const r = races[race];
  const p = $("mon-road");
  if (race !== "president" && race !== "governor") { p.innerHTML = `<h3>How it is decided</h3><p style="margin:0;font-size:.95rem">${esc(r.rule)}</p>`; return; }
  const goal = race === "president" ? r.spreadGoal : null;
  const sp = Object.keys(data?.national?.totals??{}).map(p=>[p,reportedSpread(data,eligibleStates(race,meta.states,races),p).states]).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]).slice(0,5);
  p.innerHTML = `<h3>The 25% spread rule (Constitution s.${race==='president'?'134':'179'})</h3><p class="muted" style="font-size:.875rem;margin:.1rem 0 .6rem">${esc(r.rule)}</p>
    ${race === "president" ? (sp.length ? sp.map(([party, n]) => `<div class="road-row"><strong class="mono">${esc(party)}</strong><div class="road-bar" role="img" aria-label="${esc(party)}: at least 25% in ${n} of 36 states"><span style="width:${(100 * n) / 36}%;background:${colour[party] ?? "#64748b"}"></span><i class="goal" style="left:${(100 * goal) / 36}%"></i></div><span class="mono">${n}/36</span></div>`).join("") + `<p class="source-note">${esc(r.spreadNote)}</p>` : `<p><strong>No reported 25% spread yet.</strong> Bars show states whose partial reports give a party 25% or more, with a two-thirds arithmetic reference at ${goal}. FCT is shown separately in the state view; no legal qualification is inferred.</p>`)
    : `<p style="font-size:.95rem">Choose a state: the governorship spread is counted over that state's LGAs (two-thirds of its LGAs at 25% or more).</p>`}`;
}

function drawLegend() {
  const r = races[race];
  const used = Object.values(data?.byState ?? {}).map((s) => s.leader?.party).filter(Boolean);
  const uniq = [...new Set(used)];
  $("mon-legend").innerHTML = (uniq.length ? uniq.map((p) => `<span><i style="background:${colour[p] ?? "#64748b"};opacity:.88"></i>${esc(p)}: largest reported share</span>`).join("") : "") +
    `<span><i style="background:var(--pending)"></i>No citizen-verified units yet</span>` +
    (r.offCycle ? `<span><i style="background:var(--line-2)"></i>No election (off-cycle)</span>` : "") +
    `<span><i class="hatch"></i>Solid fill = declared by ${race==='local-government'?'the relevant SIEC':'INEC'} (none yet)</span>`;
}

function drawTable() {
  const tb = document.querySelector("#mon-table tbody");
  tb.innerHTML = eligibleStates(race,meta.states,races).sort((a, b) => a.name.localeCompare(b.name, "en-GB")).map((s) => {
    const { s: st, t, sum } = rows(s.iso);
    const l = st?.leader;
    return `<tr><th scope="row">${esc(s.name)}</th><td>${l?.party ? `<span class="zone-swatch" style="background:${colour[l.party] ?? "#64748b"}"></span>${esc(l.party)}` : l?.tie?'Tied reported votes':races[race].offCycle?.includes(s.iso) ? "No election (off-cycle)" : "No results yet"}</td><td class="num">${l?.party ? (100*l.share).toFixed(1) + "%" : "—"}</td><td class="num">${st?.units>0?nf.format(sum):'—'}</td><td class="num">${nf.format(st?.units ?? 0)}</td></tr>`;
  }).join("");
}

async function setRace(k) {
  if(!Object.hasOwn(races,k))return;
  race = k;
  pick.value = k;
  document.querySelectorAll("[data-race]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.race === k)));
  history.replaceState(null, "", `?race=${k}${DEMO ? "&demo=1" : ""}`);
  rebuildStatePick();applyFeed(resultsFeed.read(k));
  window.dispatchEvent(new CustomEvent("binchika:race", { detail: k }));
  applyFeed(await resultsFeed.watch(k));
}

$("demo-banner").hidden = !DEMO;
window.addEventListener("binchika:dashboard-race", (e) => { if (e.detail !== race && races[e.detail]) setRace(e.detail); });
window.addEventListener('binchika:dashboard-state',e=>selectState(e.detail,false));
resultsFeed.subscribe(applyFeed);
window.addEventListener('binchika:parties',e=>{const p=e.detail;if(!p?.parties||!p?.palette)return;p.parties.forEach((party,i)=>{colour[party.acronym]=/^#[0-9a-f]{6}$/i.test(p.palette[i])?p.palette[i]:'#64748b';});drawLegend();drawState();repaint();});
window.dispatchEvent(new Event('binchika:request-parties'));
$("demo-wm").hidden = !DEMO;
await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/assets/vendor/maplibre-gl.js"; s.onload = res; s.onerror = rej; document.head.append(s); }).then(initMap).catch(() => { $("mon-map").innerHTML = `<p style="padding:1rem">The map needs WebGL. Use the table below.</p>`; });
await setRace(race);
