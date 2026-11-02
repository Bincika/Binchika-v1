// Where is the active country still written into the code? (session 98; docs/TENANT-CONFIG.md)
// Usage: node scripts/tenant-audit.mjs [--files]
// Terms come from the active tenant (country name and adjective, electoral body and results-portal short names, the
// ISO prefix of area codes, capital, time zone). Each hit is counted under:
//   config   tenant_config.json, tenants/            (where country values belong)
//   data     site/data/, data/                        (country data a fork replaces)
//   content  src/pages/, src/kb/, docs/               (page text a fork rewrites)
//   code     functions/, workers/, site/assets/js/, scripts/, supabase/, db/, src/ other   (should trend to zero)
//   tests    tests/                                   (Nigeria fixtures for the example tenant)
// Generated files (*.generated.js, built site/*.html) are skipped.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadTenant } from "./lib/tenant.mjs";

const t = loadTenant();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const terms = [t.country, `${t.country}n`, t.electoralBody.short, t.electoralBody.resultsPortalShort, `${t.iso}-`, t.locale.city, t.locale.timeZone].filter(Boolean);
const rx = new RegExp(terms.map((w) => (w.endsWith("-") ? `\\b${esc(w)}[A-Z]{2}\\b` : `\\b${esc(w)}\\b`)).join("|"), "g");
const kind = (f) => (/^(tenant_config\.json|tenants\/)/.test(f) ? "config" : /^(site\/data|data)\//.test(f) ? "data" : /^(src\/pages|src\/kb|docs)\//.test(f) || /\.md$/.test(f) ? "content" : /^tests\//.test(f) ? "tests" : "code");
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n")
  .filter((f) => !/\.(png|jpe?g|webp|gif|ico|woff2?|pdf|mp4|glb|bin|xlsx|zip|svg)$/i.test(f) && !/generated\.js$/.test(f) && !/^site\/.*\.html$/.test(f) && !/^site\/assets\/(vendor|js\/lib)\//.test(f) && !/package-lock\.json$/.test(f));
const sum = {}, byFile = [];
for (const f of files) {
  let s; try { s = readFileSync(f, "utf8"); } catch { continue; }
  const n = (s.match(rx) ?? []).length;
  if (!n) continue;
  const k = kind(f);
  sum[k] = (sum[k] ?? 0) + n;
  byFile.push([k, n, f]);
}
console.log(`tenant ${t.id} (${t.country}); terms: ${terms.join(", ")}`);
for (const k of ["config", "data", "content", "code", "tests"]) console.log(`${k.padEnd(8)} ${String(sum[k] ?? 0).padStart(6)}  in ${byFile.filter(([x]) => x === k).length} files`);
if (process.argv.includes("--files")) for (const [k, n, f] of byFile.filter(([x]) => x === "code").sort((a, b) => b[1] - a[1])) console.log(`  code ${String(n).padStart(4)}  ${f}`);
