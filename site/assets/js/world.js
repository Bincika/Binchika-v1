// Full-bleed, flat Equal Earth world map (true relative areas; no globe outline).
// Country picker is strictly A–Z; detail loads on demand with every field cited.
import * as d3 from "/assets/vendor/d3-world.js";
import { feature, mesh } from "/assets/vendor/topojson.js";

const host = document.getElementById("world");
if (host) init(host);

async function init(host) {
  const [topo, data] = await Promise.all([
    fetch("/data/world/countries-110m.topo.json").then((r) => r.json()),
    fetch("/data/world/countries.json").then((r) => r.json()),
  ]);
  const index = data.countries;
  const countries = feature(topo, topo.objects.countries).features.filter((f) => f.id && f.id !== "010"); // no Antarctica
  const W = 1200;
  const projection = d3.geoEqualEarth().fitWidth(W, { type: "FeatureCollection", features: countries });
  const path = d3.geoPath(projection);
  const [[, y0], [, y1]] = path.bounds({ type: "FeatureCollection", features: countries });
  const H = Math.ceil(y1 - y0 + 16);
  projection.translate([projection.translate()[0], projection.translate()[1] - y0 + 8]);

  const svg = d3.select(host).append("svg")
    .attr("viewBox", `0 0 ${W} ${H}`)
    .attr("preserveAspectRatio", "xMidYMid slice")
    .attr("role", "img")
    .attr("aria-label", "Flat world map in the Equal Earth projection, which keeps every country's true relative size. Use the country list to choose a country.");
  const g = svg.append("g");
  const paths = g.append("g").selectAll("path").data(countries).join("path")
    .attr("class", (d) => `country${index[d.id]?.region === "Africa" ? " af" : ""}${d.id === "566" ? " ng" : ""}`)
    .attr("d", path)
    .attr("data-id", (d) => d.id);
  g.append("path").attr("fill", "none").attr("stroke", "var(--sea)").attr("stroke-width", 0.6).attr("vector-effect", "non-scaling-stroke").attr("d", path(mesh(topo, topo.objects.countries, (a, b) => a !== b)));
  const [ax, ay] = projection([7.4951, 9.0579]); // Abuja
  const pulse = g.append("circle").attr("class", "pulse").attr("cx", ax).attr("cy", ay).attr("r", 10);
  const dot = g.append("circle").attr("cx", ax).attr("cy", ay).attr("r", 2.8).attr("fill", "var(--ink)").attr("pointer-events", "none");

  // drag + pinch; wheel zoom only with Ctrl/⌘ so the page still scrolls
  const zoom = d3.zoom().scaleExtent([1, 12]).translateExtent([[0, 0], [W, H]])
    .filter((e) => (e.type === "wheel" ? e.ctrlKey || e.metaKey : !e.button))
    .on("zoom", (e) => {
      g.attr("transform", e.transform);
      pulse.attr("r", 10 / e.transform.k); // markers keep their on-screen size
      dot.attr("r", 2.8 / e.transform.k);
    });
  svg.call(zoom).on("dblclick.zoom", null);

  const tip = host.querySelector(".world-tip");
  paths
    .on("pointermove", (e, d) => {
      const r = host.getBoundingClientRect();
      tip.textContent = index[d.id]?.name ?? "—";
      tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 170) + "px";
      tip.style.top = e.clientY - r.top + 14 + "px";
      tip.style.opacity = 1;
    })
    .on("pointerleave", () => (tip.style.opacity = 0))
    .on("click", (e, d) => select(d.id));

  // strictly alphabetical picker (en-GB collation, accents handled)
  const pick = host.querySelector("#country-pick");
  const coll = new Intl.Collator("en-GB", { sensitivity: "base" });
  for (const [id, c] of Object.entries(index).sort((a, b) => coll.compare(a[1].name, b[1].name))) pick.add(new Option(c.name, id));
  pick.addEventListener("change", () => (pick.value ? select(pick.value) : reset()));

  const panel = host.querySelector(".country-panel");
  host.querySelector("[data-zoom=in]").addEventListener("click", () => svg.transition().duration(450).call(zoom.scaleBy, 1.6));
  host.querySelector("[data-zoom=out]").addEventListener("click", () => svg.transition().duration(450).call(zoom.scaleBy, 1 / 1.6));
  host.querySelector("[data-zoom=reset]").addEventListener("click", reset);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) reset(); });

  function reset() {
    panel.hidden = true;
    pick.value = "";
    paths.classed("sel", false);
    svg.transition().duration(650).call(zoom.transform, d3.zoomIdentity);
    dispatchEvent(new CustomEvent("countryfocus", { detail: null }));
  }

  async function select(id) {
    const f = countries.find((c) => c.id === id);
    if (!f) return;
    pick.value = id;
    paths.classed("sel", (d) => d.id === id);
    const [[x0, yy0], [x1, yy1]] = path.bounds(f);
    const wide = host.clientWidth > 760;
    const k = Math.min(7, 0.5 / Math.max((x1 - x0) / W, (yy1 - yy0) / H));
    const cx = (x0 + x1) / 2 + (wide ? (W * 0.17) / k : 0);
    svg.transition().duration(750).ease(d3.easeCubicOut).call(zoom.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-cx, -(yy0 + yy1) / 2));
    panel.hidden = false;
    panel.innerHTML = `<p class="muted">Loading ${esc(index[id]?.name ?? "")}…</p>`;
    let c = null;
    try { c = await fetch(`/data/world/c/${id}.json`).then((r) => (r.ok ? r.json() : null)); } catch {}
    panel.innerHTML = renderPanel(id, c);
    panel.querySelector(".close").addEventListener("click", reset);
    const more = panel.querySelector(".more-btn");
    more?.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") !== "true";
      more.setAttribute("aria-expanded", String(open));
      more.textContent = open ? "Less info" : "More info";
      panel.querySelectorAll(".kv-more").forEach((el) => (el.hidden = !open));
    });
    dispatchEvent(new CustomEvent("countryfocus", { detail: c }));
  }

  // deep link: /?c=566
  const qc = new URLSearchParams(location.search).get("c");
  if (qc && index[qc]) select(qc);
}

const nf = new Intl.NumberFormat("en-GB");
const compact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const flag = (iso2) => (iso2 ? String.fromCodePoint(...[...iso2.toUpperCase()].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : "");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const fmtDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function stat(s, fmt) {
  if (!s) return `<dd>—<small>no recent data</small></dd>`;
  return `<dd>${fmt(s.value)}<small>${s.year} · <a href="${s.url}" rel="noopener">${esc(s.source)}</a></small></dd>`;
}

function renderPanel(id, c) {
  const close = `<button class="icon-btn close" type="button" aria-label="Close country panel"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
  if (!c) return `${close}<p>No data for this territory yet.</p>`;
  const s = c.stats ?? {};
  const fb = c.factbook;
  const gov = [...new Set([...(c.government?.forms ?? []), c.government?.factbook].filter(Boolean).map((x) => x.toLowerCase()))];
  const indep = c.independence
    ? `<dt>Independence</dt><dd>${fmtDate(c.independence.date)}<small><a href="${c.independence.url}" rel="noopener">${esc(c.independence.source)}</a></small></dd>`
    : fb?.independence ? `<dt>Independence</dt><dd style="font-size:.95rem">${esc(fb.independence)}<small>World Factbook</small></dd>`
    : c.inception ? `<dt>Inception (Wikidata)</dt><dd>${fmtDate(c.inception.date)}<small>Often, but not always, the independence date</small></dd>` : "";
  return `${close}
    <p class="eyebrow" style="margin-bottom:.4rem">${esc(c.subregion ?? c.region)}</p>
    <h3><span class="flag" aria-hidden="true">${flag(c.iso2)}</span>${esc(c.name)}</h3>
    <p class="muted" style="margin:.2rem 0 0;font-size:.875rem">${esc(c.official)}</p>
    <dl class="kv">
      <div><dt>Capital</dt><dd>${esc(c.capital.join(", ") || "—")}</dd></div>
      <div><dt>Population</dt>${stat(s.population, (v) => compact.format(v))}</div>
      <div class="wide"><dt>Government</dt><dd style="font-size:.98rem">${gov.length ? esc(cap(gov.join(" · "))) : "—"}<small>Wikidata P122 · World Factbook</small></dd></div>
      <div><dt>Land area</dt>${stat(s.landArea, (v) => nf.format(Math.round(v)) + " km²")}</div>
      <div><dt>GDP</dt>${stat(s.gdp, (v) => "US$" + compact.format(v))}</div>
      <div><dt>Inflation</dt>${stat(s.inflation, (v) => v.toFixed(1) + "%")}</div>
      <div><dt>Govt debt</dt>${stat(s.debt, (v) => v.toFixed(1) + "% of GDP")}</div>
      ${indep ? `<div class="wide">${indep}</div>` : ""}
      ${c.leaders ? `<div class="wide"><dt>Head of state · government</dt><dd>${esc(c.leaders.headOfState.join(", ") || "—")} · ${esc(c.leaders.headOfGovernment.join(", ") || "—")}<small>Wikidata, current statements; may lag recent changes</small></dd></div>` : ""}
      <div class="wide kv-more" hidden><dt>Languages</dt><dd class="fact-list">${esc(c.languages.join(", ") || "—")}</dd></div>
      ${c.ethnicGroups?.length ? `<div class="wide kv-more" hidden><dt>Peoples (Wikidata, not exhaustive)</dt><dd class="fact-list">${esc(c.ethnicGroups.map((e) => e.replace(/ people$/, "")).join(", "))}</dd></div>` : ""}
      ${fb?.religions ? `<div class="wide kv-more" hidden><dt>Religions</dt><dd class="fact-list">${esc(fb.religions)}</dd></div>` : ""}
      ${fb?.naturalResources ? `<div class="wide kv-more" hidden><dt>Natural resources</dt><dd class="fact-list">${esc(fb.naturalResources)}</dd></div>` : ""}
      ${fb?.climate ? `<div class="wide kv-more" hidden><dt>Climate</dt><dd class="fact-list">${esc(fb.climate)}</dd></div>` : ""}
      ${fb?.terrain ? `<div class="wide kv-more" hidden><dt>Terrain</dt><dd class="fact-list">${esc(fb.terrain)}</dd></div>` : ""}
      ${c.hdi ? `<div class="kv-more" hidden><dt>Human Development Index</dt><dd>${c.hdi.value.toFixed(3)}<small>${c.hdi.year} · UNDP via Wikidata</small></dd></div>` : ""}
      ${c.currencies?.length ? `<div class="kv-more" hidden><dt>Currency</dt><dd style="font-size:.95rem">${esc(c.currencies.join(", "))}</dd></div>` : ""}
      ${c.borders?.length ? `<div class="wide kv-more" hidden><dt>Borders ${c.landlocked ? "(landlocked)" : ""}</dt><dd class="fact-list">${esc(c.borders.join(", "))}</dd></div>` : ""}
      ${c.callingCode ? `<div class="kv-more" hidden><dt>Calling code</dt><dd>${esc(c.callingCode)}</dd></div>` : ""}
      <div class="wide kv-more" hidden><dt>History &amp; culture</dt><dd class="fact-list"><span class="writing">● Being written</span> from indigenous primary sources first, with citations. We do not reuse foreign-government narratives here.</dd></div>
    </dl>
    <button class="btn btn-ghost btn-sm more-btn" type="button" aria-expanded="false">More info</button>
    <p class="cites">${citeLine(c)} · <a href="/sources/?c=${id}">All sources for ${esc(c.name)} →</a></p>`;
}

export function citeLine(c) {
  const parts = [c.sources.identity, c.sources.geometry, "World Bank WDI (CC BY 4.0)", "Wikidata (CC0)"];
  if (c.factbook) parts.push("CIA World Factbook (public domain; not an African primary source)");
  if (c.independence) parts.push(c.independence.source);
  return parts.map(esc).join(" · ");
}
