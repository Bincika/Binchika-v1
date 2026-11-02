// Nigeria 3D map: country → zone → state → LGA (→ ward → polling unit once INEC PU data lands).
// MapLibre GL with our own GeoJSON only: no tile provider, no API key. Falls back to 2D SVG without WebGL.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
import { feature, merge } from "/assets/vendor/topojson.js";

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nf = new Intl.NumberFormat("en-GB");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ZONE_ORDER = ["NW", "NE", "NC", "SW", "SE", "SS"];
const ZONE_LABEL = { NW: "North-West", NE: "North-East", NC: "North-Central + FCT", SW: "South-West", SE: "South-East", SS: "South-South" };
const zoneColour = (z) => css(`--z-${z.toLowerCase()}`);
const RACE = {
  explore: { label: "Explore", rule: null },
  president: { label: "President · 16 Jan 2027", rule: "Constitution s.134(2): the most votes, and at least 25% of votes in at least two-thirds of all the states and the FCT." },
  senate: { label: "Senate · 16 Jan 2027", rule: "Each of the 109 senatorial districts is won by the candidate with the most votes." },
  house: { label: "House of Representatives · 16 Jan 2027", rule: "Each of the 360 federal constituencies is won by the candidate with the most votes." },
  governor: { label: "Governorship · 6 Feb 2027", rule: "Constitution s.179(2): the most votes, and at least 25% of votes in at least two-thirds of the state's LGAs." },
};

const [sTopo, lTopo, meta, parties] = await Promise.all(
  ["/data/geo/ng-states.topo.json", "/data/geo/ng-lgas.topo.json", "/data/states.json", "/data/parties.json"].map((u) => fetch(u).then((r) => r.json()))
);
const info = Object.fromEntries(meta.states.map((s) => [s.iso, s]));
const partyColour = Object.fromEntries(parties.parties.map((p, i) => [p.acronym, parties.palette[i]]));
const sObj = Object.values(sTopo.objects)[0];
const states = feature(sTopo, sObj);
const zoneIdx = {};
states.features.forEach((f, i) => { const s = info[f.properties.iso]; f.id = i; Object.assign(f.properties, { name: s.name, zone: s.zone, house: s.house, lgas: s.lgas, senate: s.senate, tint: (zoneIdx[s.zone] = (zoneIdx[s.zone] ?? -1) + 1) % 4 }); });
const zones = { type: "FeatureCollection", features: ZONE_ORDER.map((z, i) => {
  const geoms = sObj.geometries.filter((g) => info[g.properties.iso].zone === z);
  const members = meta.states.filter((s) => s.zone === z);
  return { type: "Feature", id: i, properties: { zone: z, name: ZONE_LABEL[z], house: members.reduce((a, s) => a + s.house, 0), states: members.length, lgas: members.reduce((a, s) => a + s.lgas, 0), senate: members.reduce((a, s) => a + s.senate, 0) }, geometry: merge(sTopo, geoms) };
}) };
const lgas = feature(lTopo, Object.values(lTopo.objects)[0]);
lgas.features.forEach((f, i) => { f.id = i; f.properties.zone = info[f.properties.stateIso]?.zone; f.properties.tint = i % 4; });

let race = "explore";
let results = null;
const view = { level: "country", zone: null, state: null, lga: null };
// Phone-first decision: upright flat map by default (no accidental tilt/rotate on touch); 3D is an opt-in toggle.
let is3d = false;

// ---------- bounds helpers ----------
function bbox(geom) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  const walk = (c) => (typeof c[0] === "number" ? (x0 = Math.min(x0, c[0]), y0 = Math.min(y0, c[1]), x1 = Math.max(x1, c[0]), y1 = Math.max(y1, c[1])) : c.forEach(walk));
  walk(geom.coordinates);
  return [[x0, y0], [x1, y1]];
}
const centroid = (geom) => { const [[a, b], [c, d]] = bbox(geom); return [(a + c) / 2, (b + d) / 2]; };
const unionBox = (fs) => fs.map((f) => bbox(f.geometry)).reduce(([[a, b], [c, d]], [[e, f2], [g, h]]) => [[Math.min(a, e), Math.min(b, f2)], [Math.max(c, g), Math.max(d, h)]]);

// ---------- map ----------
const host = $("ng-map");
let map = null;
const gl = await loadMapLibre();
if (gl) initMap(gl); else initFallback();
queueMicrotask(() => render()); // panels, crumbs and lists work before (or without) WebGL

async function loadMapLibre() {
  try {
    await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/assets/vendor/maplibre-gl.js"; s.onload = res; s.onerror = rej; document.head.append(s); });
    const c = document.createElement("canvas");
    return c.getContext("webgl2") || c.getContext("webgl") ? window.maplibregl : null;
  } catch { return null; }
}

function stateFill() {
  if (race === "explore") return ["match", ["get", "tint"], 0, ["get", "c0"], 1, ["get", "c1"], 2, ["get", "c2"], ["get", "c3"]];
  const pairs = Object.entries(results?.byState ?? {}).filter(([, s]) => s.leader?.party).flatMap(([iso, s]) => [iso, partyColour[s.leader.party] ?? "#999"]);
  return pairs.length ? ["match", ["get", "iso"], ...pairs, css("--pending")] : css("--pending");
}

function initMap(maplibregl) {
  map = new maplibregl.Map({
    container: host,
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "rgba(0,0,0,0)" } }] },
    bounds: [[2.4, 4.0], [14.9, 14.1]],
    fitBoundsOptions: { padding: 40 },
    pitch: 0, bearing: 0, maxPitch: 70,
    dragRotate: false, touchPitch: false, pitchWithRotate: false,
    cooperativeGestures: true,
    attributionControl: { compact: true, customAttribution: "GRID3 / geoBoundaries CC BY 4.0" },
  });
  window.__binchikaMap = map; // debugging handle (read-only use)
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.on("load", () => {
    map.addSource("zones", { type: "geojson", data: zones });
    map.addSource("states", { type: "geojson", data: states });
    map.addSource("lgas", { type: "geojson", data: lgas });
    const hover = (base, lift) => ["case", ["boolean", ["feature-state", "hover"], false], lift, base];
    map.addLayer({ id: "zones-3d", type: "fill-extrusion", source: "zones", paint: {
      "fill-extrusion-color": ["match", ["get", "zone"], ...ZONE_ORDER.flatMap((z) => [z, zoneColour(z)]), "#999"],
      "fill-extrusion-height": hover(["*", ["get", "house"], 900], ["*", ["get", "house"], 1300]),
      "fill-extrusion-opacity": 0.94, "fill-extrusion-vertical-gradient": true } });
    map.addLayer({ id: "states-ctx", type: "fill", source: "states", paint: { "fill-color": css("--land"), "fill-opacity": 0.55, "fill-outline-color": css("--surface") }, layout: { visibility: "none" } });
    map.addLayer({ id: "states-3d", type: "fill-extrusion", source: "states", paint: {
      "fill-extrusion-color": stateFill(),
      "fill-extrusion-height": hover(["*", ["get", "house"], 2600], ["*", ["get", "house"], 3800]),
      "fill-extrusion-opacity": 0.95, "fill-extrusion-vertical-gradient": true }, layout: { visibility: "none" } });
    map.addLayer({ id: "lgas-3d", type: "fill-extrusion", source: "lgas", paint: {
      "fill-extrusion-color": ["case", ["boolean", ["feature-state", "sel"], false], css("--signal"), ["match", ["get", "tint"], 0, ["get", "c0"], 1, ["get", "c1"], 2, ["get", "c2"], ["get", "c3"]]],
      "fill-extrusion-height": hover(4500, 11000),
      "fill-extrusion-opacity": 0.96 }, layout: { visibility: "none" } });
    map.addLayer({ id: "lgas-line", type: "line", source: "lgas", paint: { "line-color": css("--surface"), "line-width": 1.2 }, layout: { visibility: "none" } });
    wireHover("zones-3d", "zones", (p) => `${p.name} · ${p.states} states · ${p.house} House seats`, (p) => openZone(p.zone));
    wireHover("states-3d", "states", (p) => `${p.name} · ${p.lgas} LGAs · ${p.house} House seats`, (p) => openState(p.iso));
    wireHover("lgas-3d", "lgas", (p) => `${p.name} LGA`, (p, f) => openLga(f.id));
    paintLgaTints();
    render(view.level !== "country"); // a selection made before WebGL was ready still flies there
  });
  addEventListener("themechange", () => setTimeout(() => { if (!map?.isStyleLoaded()) return; map.setPaintProperty("zones-3d", "fill-extrusion-color", ["match", ["get", "zone"], ...ZONE_ORDER.flatMap((z) => [z, zoneColour(z)]), "#999"]); map.setPaintProperty("states-ctx", "fill-color", css("--land")); map.setPaintProperty("lgas-line", "line-color", css("--surface")); paintLgaTints(); paintStates(); }, 60));
}

function paintStates() { if (map?.getLayer("states-3d")) map.setPaintProperty("states-3d", "fill-extrusion-color", stateFill()); }

// LGA demarcation: four tints of the zone colour so neighbouring LGAs read as distinct
function paintLgaTints() {
  const mix = (hex, t) => { const n = parseInt(hex.slice(1), 16); const k = [0.0, 0.18, 0.34, -0.14][t]; const f = (c) => Math.round(k >= 0 ? c + (255 - c) * k : c * (1 + k)); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; };
  for (const f of [...lgas.features, ...states.features]) { const base = zoneColour(f.properties.zone ?? "NC") || "#888888"; for (let t = 0; t < 4; t++) f.properties["c" + t] = mix(base, t); }
  map.getSource("lgas")?.setData(lgas);
  map.getSource("states")?.setData(states);
}

let hovered = null;
function wireHover(layer, source, text, onClick) {
  const tip = $("map-tip");
  map.on("mousemove", layer, (e) => {
    const f = e.features[0];
    if (hovered && (hovered.id !== f.id || hovered.source !== source)) map.setFeatureState(hovered, { hover: false });
    hovered = { source, id: f.id };
    map.setFeatureState(hovered, { hover: true });
    map.getCanvas().style.cursor = "pointer";
    tip.textContent = text(f.properties);
    tip.style.left = Math.min(e.point.x + 14, host.clientWidth - 220) + "px";
    tip.style.top = e.point.y + 14 + "px";
    tip.style.opacity = 1;
  });
  map.on("mouseleave", layer, () => { if (hovered) map.setFeatureState(hovered, { hover: false }); hovered = null; map.getCanvas().style.cursor = ""; tip.style.opacity = 0; });
  map.on("click", layer, (e) => onClick(e.features[0].properties, e.features[0]));
}

const markers = [];
function setMarkers(items) {
  markers.splice(0).forEach((m) => m.remove());
  if (!map) return;
  for (const [lngLat, text] of items) {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "font:700 11px var(--f-body);color:#0D0E10;background:rgb(255 255 255 / .82);padding:2px 7px;border-radius:999px;pointer-events:none;white-space:nowrap;box-shadow:0 1px 3px rgb(0 0 0 / .2)";
    markers.push(new window.maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map));
  }
}

// ---------- navigation ----------
function openZone(z) { Object.assign(view, { level: "zone", zone: z, state: null, lga: null }); render(true); }
function openState(iso) { Object.assign(view, { level: "state", zone: info[iso].zone, state: iso, lga: null }); render(true); }
function openLga(id) { Object.assign(view, { level: "lga", lga: id }); render(true); }
function goTo(level) {
  if (level === "country") Object.assign(view, { level, zone: null, state: null, lga: null });
  if (level === "zone") Object.assign(view, { level, state: null, lga: null });
  if (level === "state") Object.assign(view, { level, lga: null });
  render(true);
}

function render(fly = false) {
  drawCrumbs();
  $("zone-pick").value = view.zone ?? "";
  $("state-pick").value = view.state ?? "";
  fillLgaPick();
  if (map?.getLayer("zones-3d")) {
    const vis = (id, on) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    vis("zones-3d", view.level === "country" && race === "explore");
    vis("states-3d", view.level !== "country" || race !== "explore");
    vis("states-ctx", view.level === "state" || view.level === "lga");
    vis("lgas-3d", view.level === "state" || view.level === "lga");
    vis("lgas-line", view.level === "state" || view.level === "lga");
    if (view.level === "zone") map.setFilter("states-3d", ["==", ["get", "zone"], view.zone]);
    else if (view.level === "state" || view.level === "lga") map.setFilter("states-3d", ["==", ["get", "iso"], "__none__"]);
    else map.setFilter("states-3d", null);
    map.setFilter("lgas-3d", ["==", ["get", "stateIso"], view.state ?? "__none__"]);
    map.setFilter("lgas-line", ["==", ["get", "stateIso"], view.state ?? "__none__"]);
    lgas.features.forEach((f) => map.setFeatureState({ source: "lgas", id: f.id }, { sel: f.id === view.lga }));
    if (fly) {
      const fs = view.level === "country" ? states.features : view.level === "zone" ? states.features.filter((f) => f.properties.zone === view.zone) : view.level === "state" ? states.features.filter((f) => f.properties.iso === view.state) : [lgas.features[view.lga]];
      map.fitBounds(unionBox(fs), { padding: { top: 70, bottom: 50, left: 40, right: 40 }, pitch: is3d ? (view.level === "lga" ? 55 : 48) : 0, bearing: is3d ? -10 : 0, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1100, maxZoom: 10 });
    }
    if (view.level === "country" && race === "explore") setMarkers(zones.features.map((f) => [centroid(f.geometry), f.properties.name]));
    else if (view.level === "zone" || (view.level === "country" && race !== "explore")) setMarkers(states.features.filter((f) => view.level === "country" || f.properties.zone === view.zone).map((f) => [centroid(f.geometry), info[f.properties.iso].short ?? f.properties.name]));
    else setMarkers([]);
  } else if (fallbackDraw) fallbackDraw();
  drawSelection();
  drawRoad();
  drawLegend();
  drawBaseline();
}

function drawCrumbs() {
  const c = $("crumbs");
  const items = [["country", "Nigeria"]];
  if (view.zone) items.push(["zone", ZONE_LABEL[view.zone]]);
  if (view.state) items.push(["state", info[view.state].short ?? info[view.state].name]);
  if (view.lga != null) items.push(["lga", lgas.features[view.lga].properties.name]);
  c.innerHTML = items.map(([lvl, label], i) => `<button type="button" data-lvl="${lvl}"${i === items.length - 1 ? ' aria-current="true"' : ""}>${esc(label)}</button>`).join("");
  c.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => goTo(b.dataset.lvl)));
}

function drawSelection() {
  const p = $("sel-panel");
  const flag = meta.notes.verified.house ? "" : ' <span class="flag-v" title="To be re-checked against INEC">VERIFY</span>';
  const leaderOf = (iso) => results?.byState?.[iso]?.leader;
  if (view.level === "country") {
    p.innerHTML = `<p class="eyebrow">${RACE[race].label}</p><h2>Federal Republic of Nigeria</h2>
      <dl class="facts"><div><dt>Zones</dt><dd>6</dd></div><div><dt>States + FCT</dt><dd>37</dd></div><div><dt>LGAs</dt><dd>774</dd></div><div><dt>Senate · House</dt><dd>109 · 360</dd></div></dl>
      <p class="muted" style="margin:0">Choose a zone on the map or in the lists above.</p>`;
  } else if (view.level === "zone") {
    const z = zones.features[ZONE_ORDER.indexOf(view.zone)].properties;
    const members = meta.states.filter((s) => s.zone === view.zone).sort((a, b) => a.name.localeCompare(b.name));
    p.innerHTML = `<p class="eyebrow"><span class="zone-swatch" style="background:${zoneColour(view.zone)}"></span>Geo-political zone</p><h2>${z.name}</h2>
      <dl class="facts"><div><dt>States</dt><dd>${z.states}</dd></div><div><dt>LGAs</dt><dd>${z.lgas}</dd></div><div><dt>Senate seats</dt><dd>${z.senate}</dd></div><div><dt>House seats${flag}</dt><dd>${z.house}</dd></div></dl>
      <div class="card-links">${members.map((s) => `<button class="btn btn-ghost btn-sm" type="button" data-state="${s.iso}">${esc(s.short ?? s.name)}</button>`).join("")}</div>`;
  } else {
    const s = info[view.state];
    const lead = leaderOf(view.state);
    const stateLgas = lgas.features.filter((f) => f.properties.stateIso === view.state).sort((a, b) => a.properties.name.localeCompare(b.properties.name));
    const lga = view.lga != null ? lgas.features[view.lga].properties : null;
    p.innerHTML = `<p class="eyebrow"><span class="zone-swatch" style="background:${zoneColour(s.zone)}"></span>${ZONE_LABEL[s.zone]}</p>
      <h2>${lga ? esc(lga.name) + " LGA" : esc(s.name)}</h2>
      <p class="muted" style="margin:0">${lga ? `${esc(s.name)} State` : `Capital: <strong style="color:var(--ink)">${esc(s.capital)}</strong>`}</p>
      ${lga ? `<p style="margin-top:1rem">Ward and polling-unit layers for this LGA open once INEC's polling-unit register is loaded and checked. Until then, no ward figures are shown, and none are estimated.</p>` :
      `<dl class="facts"><div><dt>LGAs</dt><dd>${s.lgas}</dd></div><div><dt>Senate seats</dt><dd>${s.senate}</dd></div><div><dt>House seats${flag}</dt><dd>${s.house}</dd></div><div><dt>Largest reported share</dt><dd style="font-size:1rem">${lead?.party ? `<span class="zone-swatch" style="background:${partyColour[lead.party]}"></span>${esc(lead.party)}` : "No results yet"}</dd></div></dl>
      <details><summary style="cursor:pointer;font-weight:700;min-height:40px;display:flex;align-items:center">${stateLgas.length} local government areas</summary>
      <div class="card-links" style="margin-top:.5rem">${stateLgas.map((f) => `<button class="btn btn-ghost btn-sm" type="button" data-lga="${f.id}">${esc(f.properties.name)}</button>`).join("")}</div></details>`}`;
  }
  p.querySelectorAll("[data-state]").forEach((b) => b.addEventListener("click", () => openState(b.dataset.state)));
  p.querySelectorAll("[data-lga]").forEach((b) => b.addEventListener("click", () => openLga(Number(b.dataset.lga))));
}

function drawRoad() {
  const p = $("road-panel");
  if (race === "explore") {
    p.innerHTML = `<h3>The rules in the Constitution</h3>
      <p style="margin:.2rem 0 .6rem;font-size:.9375rem"><strong>President:</strong> the most votes nationally, <em>and</em> at least 25% in two-thirds of the states and the FCT (Constitution s.134).</p>
      <p style="margin:0;font-size:.9375rem"><strong>Governor:</strong> the most votes in the state, <em>and</em> at least 25% in two-thirds of its LGAs (s.179).</p>
      <p class="source-note">Binchika shows these spreads in the citizen-reported tallies only. It does not apply the rules: INEC declares results, and courts decide disputes.</p>`;
    return;
  }
  const isGov = race === "governor";
  const areaN = isGov && view.state ? info[view.state].lgas : 36;
  const goal = Math.ceil((2 * areaN) / 3);
  const sp = Object.entries(results?.spread ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const nat = results?.national?.leader;
  p.innerHTML = `<h3>The rules · ${esc(RACE[race].label)}</h3>
    <p style="font-size:.875rem;margin:.2rem 0 .8rem" class="muted">${esc(RACE[race].rule)}</p>
    ${race === "president" || isGov ? (sp.length ? sp.map(([party, n]) => `<div class="road-row"><strong class="mono">${esc(party)}</strong><div class="road-bar" role="img" aria-label="${esc(party)}: 25% or more in ${n} of ${areaN}"><span style="width:${(100 * n) / areaN}%;background:${partyColour[party] ?? "#888"}"></span><i class="goal" style="left:${(100 * goal) / areaN}%"></i></div><span class="mono">${n}/${areaN}</span></div>`).join("") + `<p class="source-note">Black tick = two-thirds (${goal} of ${areaN}${isGov ? " LGAs" : " states"}).${isGov ? "" : " Whether the FCT counts as a 37th state is a question for the courts."}</p>` : `<p><strong>No results yet.</strong> The bars fill as polling units report. Each bar counts the ${isGov ? "LGAs" : "states"} where a party has at least 25%, with a tick at ${goal} of ${areaN}${isGov ? (view.state ? "" : " (choose a state)") : ""}.</p>`) : `<p><strong>No results yet.</strong> Seat counts are not shown. These tallies are not a constituency allocation.</p>`}
    <dl class="facts" style="margin-bottom:0"><div><dt>Units reported</dt><dd>${nf.format(results?.units?.reported ?? 0)}</dd></div><div><dt>Remaining</dt><dd>${nf.format((results?.units?.total ?? 176846) - (results?.units?.reported ?? 0))}</dd></div></dl>
    ${nat?.party ? `<p class="source-note">Largest share of the citizen-reported tallies: ${esc(nat.party)}. Not a result: only INEC declares results.</p>` : ""}`;
}

function drawLegend() {
  const items = race === "explore" ? ZONE_ORDER.map((z) => [zoneColour(z), ZONE_LABEL[z]]) : [[css("--pending"), "No results yet"], ...parties.parties.map((p, i) => [parties.palette[i], p.acronym])];
  $("legend").innerHTML = items.map(([c, l]) => `<li><i style="background:${c}"></i>${esc(l)}</li>`).join("") + (race === "explore" ? `<li style="flex-basis:100%" class="muted">Height = House of Representatives seats</li>` : `<li style="flex-basis:100%" class="muted">Party colours are assigned alphabetically by acronym and mean nothing. <a href="/parties/">Why?</a></li>`);
}

async function loadResults() {
  if (race === "explore") { results = null; return; }
  try { results = await fetch(`/api/results?race=${race}`).then((r) => r.json()); } catch { results = null; }
  $("units-chip").innerHTML = `<i></i>${nf.format(results?.units?.reported ?? 0)} of ${nf.format(results?.units?.total ?? 176846)} polling units reported`;
}

// ---------- controls ----------
for (const z of ZONE_ORDER) $("zone-pick").add(new Option(ZONE_LABEL[z], z));
for (const s of [...meta.states].sort((a, b) => a.name.localeCompare(b.name))) $("state-pick").add(new Option(s.name, s.iso));
$("zone-pick").addEventListener("change", (e) => (e.target.value ? openZone(e.target.value) : goTo("country")));
$("state-pick").addEventListener("change", (e) => (e.target.value ? openState(e.target.value) : goTo(view.zone ? "zone" : "country")));
document.querySelectorAll("[data-race]").forEach((b) => b.addEventListener("click", async () => {
  race = b.dataset.race;
  document.querySelectorAll("[data-race]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  await loadResults();
  paintStates();
  render();
}));
setInterval(async () => { if (race !== "explore") { await loadResults(); paintStates(); drawRoad(); } }, 30000);

const tbody = document.querySelector("#state-table tbody");
for (const s of [...meta.states].sort((a, b) => a.name.localeCompare(b.name))) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<th scope="row">${esc(s.name)}</th><td>${esc(s.capital)}</td><td><span class="zone-swatch" style="background:${zoneColour(s.zone)}"></span>${ZONE_LABEL[s.zone]}</td><td class="num">${s.lgas}</td><td class="num">${s.senate}</td><td class="num">${s.house}</td><td>No results yet</td>`;
  tbody.append(tr);
}

// ---------- 2D fallback (no WebGL) ----------
let fallbackDraw = null;
async function initFallback() {
  const { geoMercator, geoPath } = await import("/assets/vendor/d3-world.js");
  $("map-hint").textContent = "2D view (3D needs WebGL)";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 800 640");
  svg.setAttribute("role", "group");
  host.append(svg);
  fallbackDraw = () => {
    const fs = view.state ? lgas.features.filter((f) => f.properties.stateIso === view.state) : view.zone ? states.features.filter((f) => f.properties.zone === view.zone) : states.features;
    const proj = geoMercator().fitExtent([[20, 60], [780, 620]], { type: "FeatureCollection", features: fs });
    const path = geoPath(proj);
    svg.innerHTML = "";
    for (const f of fs) {
      const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
      el.setAttribute("d", path(f));
      el.setAttribute("fill", view.state ? f.properties.c0 ?? zoneColour(f.properties.zone) : race === "explore" ? zoneColour(f.properties.zone) : css("--pending"));
      el.setAttribute("stroke", css("--surface"));
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", f.properties.name);
      el.style.cursor = "pointer";
      const go = () => (view.state ? openLga(f.id) : view.zone ? openState(f.properties.iso) : openZone(f.properties.zone));
      el.addEventListener("click", go);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      svg.append(el);
    }
  };
  render();
}

// ---------- 3D toggle (opt-in) ----------
const t3d = $("toggle-3d");
t3d?.addEventListener("click", () => {
  is3d = !is3d;
  t3d.setAttribute("aria-pressed", String(is3d));
  t3d.textContent = is3d ? "2D" : "3D";
  if (!map) return;
  if (is3d) { map.dragRotate.enable(); map.touchPitch.enable(); map.easeTo({ pitch: 48, bearing: -10, duration: 700 }); }
  else { map.dragRotate.disable(); map.touchPitch.disable(); map.easeTo({ pitch: 0, bearing: 0, duration: 600 }); }
  $("map-hint").textContent = is3d ? "Right-drag or two fingers to tilt and rotate" : "Upright 2D · tap a zone, state or LGA";
});

// ---------- LGA dropdown ----------
const coll = new Intl.Collator("en-GB", { sensitivity: "base" });
function fillLgaPick() {
  const sel = $("lga-pick");
  if (!sel) return;
  const keep = view.lga != null ? String(view.lga) : "";
  sel.replaceChildren(new Option(view.state ? `Choose an LGA in ${info[view.state].short ?? info[view.state].name}…` : "Choose an LGA (all 774)…", ""));
  const states = view.state ? [view.state] : meta.states.map((s) => s.iso).sort((a, b) => coll.compare(info[a].name, info[b].name));
  for (const iso of states) {
    const group = view.state ? sel : document.createElement("optgroup");
    if (!view.state) group.label = info[iso].name;
    lgas.features.filter((f) => f.properties.stateIso === iso).sort((a, b) => coll.compare(a.properties.name, b.properties.name))
      .forEach((f) => group.append(new Option(f.properties.name, String(f.id))));
    if (!view.state) sel.append(group);
  }
  sel.value = keep;
}
$("lga-pick")?.addEventListener("change", (e) => {
  if (!e.target.value) return;
  const f = lgas.features[Number(e.target.value)];
  Object.assign(view, { level: "lga", zone: info[f.properties.stateIso].zone, state: f.properties.stateIso, lga: f.id });
  render(true);
});

// ---------- Pre-election baseline (INEC registered voters, timestamped) ----------
import("/assets/js/lib/baseline.js").then(async ({ checkAgainstBaseline, lgaKey, MATERIAL_PCT, MATERIAL_ABS }) => {
  const base = await fetch("/data/baselines/registered-voters.json").then((r) => r.json()).catch(() => null);
  window.__baseline = { base, checkAgainstBaseline, lgaKey, MATERIAL_PCT, MATERIAL_ABS };
  drawBaseline();
});
function drawBaseline() {
  const p = $("baseline-panel");
  const B = window.__baseline;
  if (!p || !B?.base) return;
  const { base, lgaKey } = B;
  const docOf = (id) => base.documents.find((d) => d.id === id);
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + ` ${TENANT.locale.zoneLabel}`;
  let label, n, rec;
  if (view.lga != null) {
    const name = lgas.features[view.lga].properties.name;
    const hit = Object.entries(base.lga[view.state] ?? {}).find(([k, v]) => v.grid3 === name || lgaKey(k) === lgaKey(name));
    label = `${name} LGA`; rec = hit?.[1]; n = rec?.registered;
  } else if (view.state) {
    label = info[view.state].name; rec = base.state[view.state]; n = rec?.registered;
  } else {
    const isos = view.zone ? meta.states.filter((s) => s.zone === view.zone).map((s) => s.iso) : Object.keys(base.state);
    n = isos.reduce((a, iso) => a + (base.state[iso]?.registered ?? 0), 0);
    label = view.zone ? ZONE_LABEL[view.zone] : "Nigeria";
    rec = base.state[isos[0]];
  }
  const doc = rec ? docOf(rec.doc) : null;
  p.innerHTML = `<h3>Registered voters · pre-election baseline</h3>
    ${n ? `<p style="margin:.2rem 0"><span class="mono" style="font-size:1.8rem;font-weight:600;letter-spacing:-.04em">${nf.format(n)}</span><br><span class="muted">${esc(label)} · INEC register (2023 baseline)</span></p>
      <p class="source-note" style="margin-top:.4rem">Captured ${when(rec.fetchedAt)} · <a href="${esc(doc?.url ?? rec.url)}" rel="noopener">INEC document</a>${doc?.retrievedFrom && doc.retrievedFrom !== doc.url ? ` (via <a href="${esc(doc.retrievedFrom)}" rel="noopener">archive copy</a>)` : ""} · SHA-256 <span class="hash">${esc((doc?.sha256 ?? "").slice(0, 12))}…</span></p>`
    : `<p><strong>Not yet published at this level.</strong> INEC LGA figures exist so far for ${Object.keys(base.lga).length} states (${base.coverage.lgas} LGAs). Others are pending, not estimated.</p>`}
    <p style="margin:.8rem 0 .4rem;font-size:.9rem"><strong>Election-day check:</strong> the register is frozen before polling. Binchika flags any announced registered figure that moves by ≥${B.MATERIAL_PCT}% (or ${nf.format(B.MATERIAL_ABS)} voters), and any accredited or vote count above the register.</p>
    ${n ? `<form id="bl-try" class="filters" style="margin-top:.4rem"><label class="sr-only" for="bl-in">Announced registered voters</label><input id="bl-in" type="number" min="0" inputmode="numeric" placeholder="Try an announced figure" style="width:12rem"><button class="btn btn-ghost btn-sm" type="submit">Check</button></form><p id="bl-out" class="source-note" role="status"></p>` : ""}`;
  $("bl-try")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = Number($("bl-in").value);
    const r = B.checkAgainstBaseline(n, { registered: v });
    $("bl-out").innerHTML = r.severity === "none" ? `No flag: ${nf.format(v)} is within tolerance of ${nf.format(n)}.`
      : `<strong style="color:var(--${r.severity === "critical" ? "bad" : "warn"})">${r.severity === "critical" ? "Critical" : "Material"} flag</strong>: before ${nf.format(n)} (captured ${when(rec.fetchedAt)}) → announced ${nf.format(v)} (${r.findings[0].delta > 0 ? "+" : ""}${nf.format(r.findings[0].delta)}, ${r.findings[0].pct}%). Example only; nothing is recorded.`;
  });
}
