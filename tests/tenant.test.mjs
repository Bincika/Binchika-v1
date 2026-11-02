import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTenant, tenantModule, localeJson } from "../scripts/lib/tenant.mjs";
import { TENANT } from "../functions/_lib/tenant.generated.js";
import { INEC_STATE_CODE, REGION_CODE, stateOfPu } from "../functions/_lib/results.js";

// Session 98: country values come from tenant_config.json → tenants/<id>/tenant.json (docs/TENANT-CONFIG.md).
const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the committed generated module and locale.json match the active tenant (rebuild after editing the tenant)", () => {
  const t = loadTenant(root);
  assert.equal(readFileSync(new URL("../functions/_lib/tenant.generated.js", import.meta.url), "utf8"), tenantModule(t));
  assert.equal(readFileSync(new URL("../site/data/locale.json", import.meta.url), "utf8"), localeJson(t));
  assert.deepEqual(TENANT, t);
});

test("Nigeria: the polling-unit table and press values are exactly the pre-config ones", () => {
  // SHA-256 of the 37-entry table as it stood in functions/_lib/results.js before session 98.
  assert.equal(sha(JSON.stringify(INEC_STATE_CODE)), "53cf4501b9575af8e549350975a450d88a2546741eaabd2ce11fc904b1c0e5a5");
  assert.equal(REGION_CODE, INEC_STATE_CODE);
  assert.equal(Object.keys(INEC_STATE_CODE).length, 37);
  assert.equal(stateOfPu("24-09-05-012"), "NG-LA");
  assert.equal(stateOfPu("37-01-01-001"), "NG-FC");
  assert.equal(TENANT.pollingUnits.total, 176846);
  assert.equal(TENANT.notice, "Citizen-verified tallies. Only INEC declares results.");
  assert.deepEqual([TENANT.locale.timeZone, TENANT.locale.zoneLabel, TENANT.electoralBody.short], ["Africa/Lagos", "WAT", "INEC"]);
});

test("the template is refused until every FILL is replaced, and a missing field is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "tenant-"));
  mkdirSync(join(dir, "tenants"));
  cpSync(join(root, "tenants"), join(dir, "tenants"), { recursive: true });
  writeFileSync(join(dir, "tenant_config.json"), JSON.stringify({ tenant: "_template" }));
  assert.throws(() => loadTenant(dir), /FILL placeholders/);
  const ng = JSON.parse(readFileSync(join(dir, "tenants/ng/tenant.json"), "utf8"));
  delete ng.pollingUnits.total;
  mkdirSync(join(dir, "tenants/zz"));
  writeFileSync(join(dir, "tenants/zz/tenant.json"), JSON.stringify(ng));
  writeFileSync(join(dir, "tenant_config.json"), JSON.stringify({ tenant: "zz" }));
  assert.throws(() => loadTenant(dir), /pollingUnits\.total/);
});

test("no hard-coded time zone in server or browser code (it comes from the tenant)", () => {
  const offenders = [];
  const scan = (dir) => { for (const f of readdirSync(new URL(dir, import.meta.url), { recursive: true })) if (/\.js$/.test(f) && !/generated/.test(f) && !/(^|[\\/])site\.js$/.test(f) && readFileSync(new URL(`${dir}${String(f).replace(/\\/g, "/")}`, import.meta.url), "utf8").includes("Africa/Lagos")) offenders.push(`${dir}${f}`); };
  scan("../functions/"); scan("../site/assets/js/"); scan("../workers/mailbox/src/");
  assert.deepEqual(offenders, [], "site.js keeps Africa/Lagos only as its offline fallback");
});
