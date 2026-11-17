// Integrity checks for the active tenant's data files. Exits non-zero on any failure.
// Usage: node scripts/validate-data.mjs
import { readFile } from "node:fs/promises";
import { loadTenant } from "./lib/tenant.mjs";

const load = async (p) => JSON.parse(await readFile(p, "utf8"));
const t = loadTenant();
const meta = await load("site/data/states.json");
const parties = await load("site/data/parties.json");
const races = await load("site/data/races.json");
let failed = 0;
const check = (ok, label) => { if (!ok) { console.error(`FAIL ${label}`); failed++; } };

const isos = meta.states.map((s) => s.iso);
check(new Set(isos).size === isos.length, "area codes are unique");
check(isos.every((i) => i.startsWith(`${t.iso}-`)), `every area code starts with ${t.iso}-`);
const prefixed = Object.values(t.pollingUnits.statePrefix);
check(new Set(prefixed).size === prefixed.length && prefixed.every((i) => isos.includes(i)), "every polling-station prefix names a real area");
check(Object.keys(t.pollingUnits.areaCount).every((k) => t.pollingUnits.statePrefix[k]), "every area count has a prefix");
const acronyms = parties.parties.map((p) => p.acronym);
check(new Set(acronyms).size === acronyms.length && acronyms.length > 0, "party acronyms are unique");
check(Object.keys(races.races).length > 0, "races are listed");
for (const r of meta.verifierRegions.regions) check(r.states.every((i) => isos.includes(i)), `verifier region ${r.id} names real areas`);
if (failed) process.exit(1);
console.log(`PASS: ${t.country}: ${isos.length} areas, ${acronyms.length} parties, ${Object.keys(races.races).length} races`);
