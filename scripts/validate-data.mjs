// Integrity checks for the public data files. Exits non-zero on any failure.
// Usage: node scripts/validate-data.mjs
import { readFile } from "node:fs/promises";

const load = async (p) => JSON.parse(await readFile(p, "utf8"));
const states = await load("site/data/states.json");
const parties = await load("site/data/parties.json");
const elections = await load("site/data/elections.json");
const topo = await load("site/data/geo/ng-states.topo.json");
const lgaTopo = await load("site/data/geo/ng-lgas.topo.json");

const errors = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };

const topoIsos = new Set(Object.values(topo.objects)[0].geometries.map((g) => g.properties.iso));
const isos = states.states.map((s) => s.iso);
check(isos.length === 37, `expected 37 states+FCT, got ${isos.length}`);
check(new Set(isos).size === isos.length, "duplicate state ISO codes");
for (const iso of isos) check(topoIsos.has(iso), `state ${iso} missing from boundary file`);

const sum = (k) => states.states.reduce((a, s) => a + s[k], 0);
check(sum("lgas") === elections.structure.lgas, `LGA total ${sum("lgas")} != ${elections.structure.lgas}`);
check(sum("senate") === elections.structure.senateSeats, `senate total ${sum("senate")} != ${elections.structure.senateSeats}`);
check(sum("house") === elections.structure.houseSeats, `house total ${sum("house")} != ${elections.structure.houseSeats}`);

const lgaByIso = {};
for (const g of Object.values(lgaTopo.objects)[0].geometries) lgaByIso[g.properties.stateIso] = (lgaByIso[g.properties.stateIso] || 0) + 1;
for (const s of states.states) check(lgaByIso[s.iso] === s.lgas, `${s.name}: ${s.lgas} LGAs listed, ${lgaByIso[s.iso]} in boundary file`);

const regionIsos = states.verifierRegions.regions.flatMap((r) => r.states);
check(regionIsos.length === 37 && new Set(regionIsos).size === 37, "verifier regions must cover each state exactly once");
check(states.verifierRegions.regions.length >= 6 && states.verifierRegions.regions.length <= 8, "verifier regions must number 6–8");

const acr = parties.parties.map((p) => p.acronym);
check(new Set(acr).size === acr.length, "duplicate party acronyms");
check([...acr].sort().join() === acr.join(), "parties must be listed alphabetically by acronym (colour slots depend on it)");
check(parties.palette.length >= acr.length, "palette shorter than party list");
check(new Set(parties.palette).size === parties.palette.length, "duplicate palette colours");

for (const e of elections.elections) check(!Number.isNaN(Date.parse(e.date)), `bad date ${e.date}`);

if (errors.length) {
  console.error("FAIL\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`PASS: ${isos.length} states, ${sum("lgas")} LGAs, ${sum("senate")} senate, ${sum("house")} house, ${acr.length} parties, ${states.verifierRegions.regions.length} regions`);
