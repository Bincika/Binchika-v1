// Per-country citation list: updates whenever the country changes (select, ?c= deep link, or back/forward).
const pick = document.getElementById("src-country");
const out = document.getElementById("src-country-out");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const { countries } = await fetch("/data/world/countries.json").then((r) => r.json());
const coll = new Intl.Collator("en-GB", { sensitivity: "base" });
for (const [id, c] of Object.entries(countries).sort((a, b) => coll.compare(a[1].name, b[1].name))) pick.add(new Option(c.name, id));

async function show(id, push = true) {
  pick.value = id ?? "";
  if (push) history.replaceState(null, "", id ? `?c=${id}` : location.pathname);
  if (!id) { out.innerHTML = `<p class="muted">Choose a country to see exactly where each of its figures comes from.</p>`; return; }
  out.innerHTML = `<p class="muted">Loading…</p>`;
  const c = await fetch(`/data/world/c/${id}.json`).then((r) => r.json());
  const items = [];
  const add = (field, source, detail = "", url = "") => items.push(`<li><b>${esc(field)}</b><span>${url ? `<a href="${esc(url)}" rel="noopener">${esc(source)}</a>` : esc(source)}${detail ? ` · ${esc(detail)}` : ""}</span></li>`);
  for (const [k, label] of [["population", "Population"], ["landArea", "Land area"], ["gdp", "GDP"], ["inflation", "Inflation"], ["debt", "Central government debt"]]) {
    const s = c.stats?.[k];
    if (s) add(label, s.source, String(s.year), s.url);
    else add(label, "No recent value in the World Bank WDI", "shown as —");
  }
  add("Name, capital, languages, currency, borders", c.sources.identity);
  add("Map geometry", c.sources.geometry);
  if (c.government?.forms?.length) add("Form of government", c.government.formsSource, c.government.forms.join(", "));
  if (c.factbook) add("Government type, resources, religions, climate, terrain", c.factbook.source, "", c.factbook.url);
  if (c.leaders) add("Head of state and government", c.leaders.source, "", c.leaders.url);
  if (c.hdi) add("Human Development Index", c.hdi.source, String(c.hdi.year));
  if (c.independence) add("Independence date", c.independence.source, c.independence.date, c.independence.url);
  else if (c.inception) add("Inception date", c.inception.source, c.inception.note);
  if (c.ethnicGroups?.length) add("Peoples", "Wikidata P172 (CC0)", "not exhaustive");
  add("History and culture", "Being written from African primary sources", "not yet published");
  out.innerHTML = `<h3 style="margin:0 0 .6rem">${esc(c.name)}</h3><ul class="src-list">${items.join("")}</ul><p class="source-note"><a href="/?c=${id}">See ${esc(c.name)} on the world map →</a></p>`;
}

pick.addEventListener("change", () => show(pick.value || null));
addEventListener("popstate", () => show(new URLSearchParams(location.search).get("c"), false));
const q = new URLSearchParams(location.search).get("c");
if (q && countries[q]) show(q, false);
