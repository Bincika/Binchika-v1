// Builds site/data/world/: Natural Earth 110m TopoJSON + per-country facts, every field cited.
// Sources (all open):
//   - Natural Earth 1:110m via world-atlas@2.0.2 (public domain)
//   - world-countries@5.1.0 by mledoze (ODbL): names, capital, region, languages, area, ISO codes
//   - World Bank WDI API (CC BY 4.0): population, land area, GDP, inflation, central govt debt
//   - Wikidata (CC0): head of state, head of government, inception date, ethnic groups
// Usage: node scripts/fetch-world.mjs
import { mkdir, writeFile } from "node:fs/promises";

const OUT = "site/data/world";
await mkdir(OUT, { recursive: true });
const getJSON = async (url, init) => {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, init); if (r.ok) return r.json(); } catch {}
    await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error("fetch failed " + url);
};

// 1. Geometry
const topo = await getJSON("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json");
await writeFile(`${OUT}/countries-110m.topo.json`, JSON.stringify(topo));
const ids = new Set(topo.objects.countries.geometries.map((g) => g.id).filter(Boolean));

// 2. Country identity (world-countries, the dataset behind REST Countries)
const rc = await getJSON("https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json");
const byNum = {};
for (const c of rc) if (c.ccn3) byNum[c.ccn3] = c;

// 3. World Bank most-recent non-empty values
const WB = {
  population: ["SP.POP.TOTL", "people"],
  landArea: ["AG.LND.TOTL.K2", "km²"],
  gdp: ["NY.GDP.MKTP.CD", "current US$"],
  inflation: ["FP.CPI.TOTL.ZG", "% annual, consumer prices"],
  debt: ["GC.DOD.TOTL.GD.ZS", "% of GDP, central government"],
};
const wb = {};
for (const [key, [code, unit]] of Object.entries(WB)) {
  const res = await getJSON(`https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&mrnev=1&per_page=400`);
  for (const row of res[1] ?? []) {
    if (row.value == null) continue;
    (wb[row.countryiso3code] ??= {})[key] = { value: row.value, year: Number(row.date), unit, source: `World Bank WDI ${code}`, url: `https://data.worldbank.org/indicator/${code}?locations=${row.countryiso3code}` };
  }
}

// 4. Wikidata: heads of state/government (current), inception, ethnic groups
const sparql = `
SELECT ?iso3 ?hosLabel ?hogLabel ?inception (GROUP_CONCAT(DISTINCT ?ethLabel; separator="|") AS ?eth) WHERE {
  ?c wdt:P298 ?iso3 ; wdt:P31 wd:Q3624078 .
  OPTIONAL { ?c p:P35 ?s1 . ?s1 ps:P35 ?hos . FILTER NOT EXISTS { ?s1 pq:P582 [] } }
  OPTIONAL { ?c p:P6 ?s2 . ?s2 ps:P6 ?hog . FILTER NOT EXISTS { ?s2 pq:P582 [] } }
  OPTIONAL { ?c wdt:P571 ?inception }
  OPTIONAL { ?c wdt:P172 ?e . ?e rdfs:label ?ethLabel . FILTER(lang(?ethLabel)="en") }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} GROUP BY ?iso3 ?hosLabel ?hogLabel ?inception`;
const wd = {};
try {
  const res = await getJSON("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(sparql), { headers: { "User-Agent": "BinchikaDataBuild/1.0 (https://binchika.com; ops@binchika.com)", Accept: "application/sparql-results+json" } });
  for (const b of res.results.bindings) {
    const k = b.iso3.value;
    const cur = (wd[k] ??= { hos: new Set(), hog: new Set(), inception: null, eth: new Set() });
    if (b.hosLabel) cur.hos.add(b.hosLabel.value);
    if (b.hogLabel) cur.hog.add(b.hogLabel.value);
    if (b.inception && !cur.inception) cur.inception = b.inception.value.slice(0, 10);
    if (b.eth?.value) b.eth.value.split("|").filter(Boolean).forEach((e) => cur.eth.add(e));
  }
} catch (e) { console.warn("wikidata skipped:", e.message); }

// 4b. Wikidata: form of government (P122) and latest Human Development Index (P1081)
const govSparql = `
SELECT ?iso3 (GROUP_CONCAT(DISTINCT ?formLabel; separator="|") AS ?forms) (MAX(?hdiYear) AS ?year) WHERE {
  ?c wdt:P298 ?iso3 ; wdt:P31 wd:Q3624078 .
  OPTIONAL { ?c wdt:P122 ?form . ?form rdfs:label ?formLabel . FILTER(lang(?formLabel)="en") }
  OPTIONAL { ?c p:P1081 ?h . ?h pq:P585 ?t . BIND(YEAR(?t) AS ?hdiYear) }
} GROUP BY ?iso3`;
const hdiSparql = `
SELECT ?iso3 ?hdi ?t WHERE { ?c wdt:P298 ?iso3 ; wdt:P31 wd:Q3624078 ; p:P1081 ?h . ?h ps:P1081 ?hdi ; pq:P585 ?t . }`;
const gov = {};
try {
  const H = { headers: { "User-Agent": "BinchikaDataBuild/1.0 (https://binchika.com)", Accept: "application/sparql-results+json" } };
  const g = await getJSON("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(govSparql), H);
  for (const b of g.results.bindings) gov[b.iso3.value] = { forms: b.forms?.value ? b.forms.value.split("|").filter(Boolean) : [] };
  const h = await getJSON("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(hdiSparql), H);
  for (const b of h.results.bindings) {
    const k = b.iso3.value, year = Number(b.t.value.slice(0, 4));
    if (!gov[k]) gov[k] = { forms: [] };
    if (!gov[k].hdi || year > gov[k].hdi.year) gov[k].hdi = { value: Number(b.hdi.value), year };
  }
} catch (e) { console.warn("wikidata gov/hdi skipped:", e.message); }

// 4c. CIA World Factbook (public domain, US government) via factbook/factbook.json — NOT an African primary source.
// Used for government type, natural resources, religions, climate, terrain. Its history narrative is NOT used.
const fb = {};
try {
  const tree = await getJSON("https://api.github.com/repos/factbook/factbook.json/git/trees/master?recursive=1", { headers: { "User-Agent": "BinchikaDataBuild" } });
  const files = tree.tree.map((t) => t.path).filter((p) => /^[a-z-]+\/[a-z]{2}\.json$/.test(p) && !p.startsWith("meta/"));
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/<[^>]+>/g, "").replace(/^the /, "").replace(/[^a-z]/g, "");
  const nameToIso3 = {};
  for (const c of rc) { nameToIso3[norm(c.name.common)] = c.cca3; nameToIso3[norm(c.name.official)] = c.cca3; for (const alt of c.altSpellings ?? []) nameToIso3[norm(alt)] ??= c.cca3; }
  const ENT = { amp: "&", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };
  const decode = (s) => s
    .replace(/&([A-Za-z])(acute|grave|circ|uml|tilde|cedil|ring|slash);/g, (_, l, m) => (l + { acute: "́", grave: "̀", circ: "̂", uml: "̈", tilde: "̃", cedil: "̧", ring: "̊", slash: "̸" }[m]).normalize("NFC"))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/g, (m, n) => ENT[n] ?? m);
  const T = (o) => decode(o?.text ?? "").replace(/<[^>]+>/g, "").trim() || null;
  for (let i = 0; i < files.length; i += 12) {
    await Promise.all(files.slice(i, i + 12).map(async (path) => {
      try {
        const j = await getJSON(`https://raw.githubusercontent.com/factbook/factbook.json/master/${path}`);
        const cn = j.Government?.["Country name"] ?? {};
        const iso3 = ["conventional short form", "conventional long form", "local short form", "former"].map((k) => nameToIso3[norm(T(cn[k]))]).find(Boolean);
        if (!iso3) return;
        fb[iso3] = {
          governmentType: T(j.Government?.["Government type"]),
          naturalResources: T(j.Geography?.["Natural resources"]),
          religions: T(j["People and Society"]?.["Religions"]),
          climate: T(j.Geography?.["Climate"]),
          terrain: T(j.Geography?.["Terrain"]),
          independence: T(j.Government?.["Independence"]),
          url: `https://github.com/factbook/factbook.json/blob/master/${path}`,
        };
      } catch {}
    }));
  }
} catch (e) { console.warn("factbook skipped:", e.message); }
const FB_SOURCE = "CIA World Factbook (public domain) via factbook/factbook.json — not an African primary source";

// 5. Merge
const countries = {};
let withWB = 0, withWD = 0;
for (const id of ids) {
  const c = byNum[id];
  if (!c) continue;
  const w = wb[c.cca3] ?? {};
  const d = wd[c.cca3];
  if (Object.keys(w).length) withWB++;
  if (d) withWD++;
  countries[id] = {
    name: c.name.common,
    official: c.name.official,
    iso2: c.cca2, iso3: c.cca3,
    capital: c.capital ?? [],
    region: c.region, subregion: c.subregion ?? null,
    languages: Object.values(c.languages ?? {}),
    area: c.area ?? null,
    unMember: Boolean(c.unMember),
    stats: w,
    leaders: d ? { headOfState: [...d.hos], headOfGovernment: [...d.hog], source: "Wikidata (CC0), current statements without an end date", url: `https://www.wikidata.org/w/index.php?search=${encodeURIComponent(c.name.common)}` } : null,
    inception: d?.inception ? { date: d.inception, note: "Wikidata 'inception' (P571): often, but not always, independence day", source: "Wikidata (CC0)" } : null,
    ethnicGroups: d ? [...d.eth].slice(0, 40) : [],
    currencies: Object.entries(c.currencies ?? {}).map(([code, v]) => `${v.name} (${code})`),
    demonym: c.demonyms?.eng?.m ?? null,
    landlocked: Boolean(c.landlocked),
    borders: (c.borders ?? []).map((b) => rc.find((x) => x.cca3 === b)?.name.common ?? b),
    callingCode: c.idd?.root ? c.idd.root + (c.idd.suffixes?.length === 1 ? c.idd.suffixes[0] : "") : null,
    government: {
      forms: gov[c.cca3]?.forms ?? [], formsSource: "Wikidata P122 'basic form of government' (CC0)",
      factbook: fb[c.cca3]?.governmentType ?? null,
    },
    hdi: gov[c.cca3]?.hdi ? { ...gov[c.cca3].hdi, source: "Wikidata P1081, from UNDP Human Development Reports" } : null,
    factbook: fb[c.cca3] ? { ...fb[c.cca3], source: FB_SOURCE } : null,
    sources: { identity: "world-countries (mledoze, ODbL)", geometry: "Natural Earth 1:110m (public domain) via world-atlas" },
  };
}
const meta = { built: new Date().toISOString(), count: Object.keys(countries).length, withWorldBank: withWB, withWikidata: withWD, withFactbook: Object.values(countries).filter((c) => c.factbook).length, withGovForm: Object.values(countries).filter((c) => c.government.forms.length).length };
// 6. Curated primary-source overrides (independence dates)
const curated = JSON.parse(await (await import("node:fs/promises")).readFile("data/curated/independence.json", "utf8"));
for (const [id, v] of Object.entries(curated)) if (id !== "note" && countries[id]) countries[id].independence = v;
// light index for the map + dropdown; full cited detail per country, loaded on demand
const index = Object.fromEntries(Object.entries(countries).map(([id, c]) => [id, { name: c.name, iso2: c.iso2, region: c.region, subregion: c.subregion }]));
await writeFile(`${OUT}/countries.json`, JSON.stringify({ meta, countries: index }));
await mkdir(`${OUT}/c`, { recursive: true });
for (const [id, c] of Object.entries(countries)) await writeFile(`${OUT}/c/${id}.json`, JSON.stringify({ id, ...c }));
console.log(JSON.stringify(meta));
const ng = countries["566"];
console.log("NG sample:", ng.name, ng.capital, ng.stats.population?.value, ng.stats.population?.year, ng.leaders?.headOfState, ng.inception?.date, ng.ethnicGroups.slice(0, 5));
