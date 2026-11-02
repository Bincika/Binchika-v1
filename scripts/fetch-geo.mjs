// Downloads open boundary data for Nigeria into data/raw/geo (raw, untouched).
// Source: geoBoundaries gbOpen (CC BY 4.0) — https://www.geoboundaries.org
// Usage: node scripts/fetch-geo.mjs
import { mkdir, writeFile } from "node:fs/promises";

const OUT = new URL("../data/raw/geo/", import.meta.url);
await mkdir(OUT, { recursive: true });

const manifest = [];
for (const level of ["ADM1", "ADM2"]) {
  const meta = await (await fetch(`https://www.geoboundaries.org/api/current/gbOpen/NGA/${level}/`)).json();
  const body = await (await fetch(meta.simplifiedGeometryGeoJSON)).text();
  const file = `geoBoundaries-NGA-${level}_simplified.geojson`;
  await writeFile(new URL(file, OUT), body);
  const fc = JSON.parse(body);
  manifest.push({
    level,
    file,
    features: fc.features.length,
    bytes: body.length,
    source: meta.boundarySource,
    license: meta.boundaryLicense,
    yearRepresented: meta.boundaryYearRepresented,
    sourceUpdated: meta.sourceDataUpdateDate,
    url: meta.simplifiedGeometryGeoJSON,
    fetchedAt: new Date().toISOString(),
  });
  console.log(level, fc.features.length, "features", body.length, "bytes", "props:", Object.keys(fc.features[0].properties).join(","));
}
await writeFile(new URL("manifest.json", OUT), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.map(({ level, license, source, yearRepresented }) => ({ level, license, source, yearRepresented }))));
