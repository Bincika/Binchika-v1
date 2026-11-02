// Builds web-ready TopoJSON from data/raw/geo into site/data/geo.
// - states: name, iso (NG-XX), zone (geo-political zone)
// - lgas: name, state (via largest polygon overlap with the state layer)
// Usage: node scripts/build-geo.mjs   (uses mapshaper via npx)
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const RAW = "data/raw/geo";
const OUT = "site/data/geo";
const ms = (args) => execFileSync("npx", ["--yes", "mapshaper@0.6.102", ...args], { stdio: ["ignore", "pipe", "inherit"], shell: true });

ms([
  `${RAW}/geoBoundaries-NGA-ADM1_simplified.geojson`,
  "-rename-fields", "name=shapeName,iso=shapeISO",
  "-filter-fields", "name,iso",
  "-simplify", "15%", "keep-shapes",
  "-o", `${OUT}/ng-states.topo.json`, "format=topojson", "quantization=1e5",
]);

ms([
  `${RAW}/geoBoundaries-NGA-ADM2_simplified.geojson`,
  "-rename-fields", "name=shapeName",
  "-filter-fields", "name",
  "-join", `${RAW}/geoBoundaries-NGA-ADM1_simplified.geojson`, "largest-overlap", "fields=shapeName,shapeISO",
  "-rename-fields", "state=shapeName,stateIso=shapeISO",
  "-simplify", "12%", "keep-shapes",
  "-o", `${OUT}/ng-lgas.topo.json`, "format=topojson", "quantization=1e5",
]);

const lgas = JSON.parse(await readFile(`${OUT}/ng-lgas.topo.json`, "utf8"));
const geoms = Object.values(lgas.objects)[0].geometries;
const perState = {};
for (const g of geoms) perState[g.properties.state] = (perState[g.properties.state] || 0) + 1;
await writeFile("data/raw/geo/lga-count-by-state.grid3.json", JSON.stringify(perState, null, 2));
console.log("lgas", geoms.length, "unassigned", geoms.filter((g) => !g.properties.state).length);
console.log(JSON.stringify(perState));
