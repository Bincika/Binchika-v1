// End-to-end pipeline test against a LOCAL dev server only (refuses non-localhost).
// reports → consensus → ledger → chain verification → results aggregation, plus negative cases.
// Usage: node scripts/e2e-pipeline.mjs http://localhost:8788
import { loadEnv } from "./lib/env.mjs";
import { verifyChain } from "../functions/_lib/ledger.js";

const base = process.argv[2] ?? "http://localhost:8788";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) { console.error("refusing: e2e writes data; local only"); process.exit(2); }
const { INGEST_TOKEN } = loadEnv();
const H = { "content-type": "application/json", authorization: `Bearer ${INGEST_TOKEN}` };
let fail = 0;
const check = (ok, label, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? " — " + extra : ""}`); if (!ok) fail++; };
const post = (p, b, h = H) => fetch(base + p, { method: "POST", headers: h, body: JSON.stringify(b) });

const pu = `24-09-05-${String(Math.floor(Math.random() * 900) + 100)}`;
const A = { APC: 120, LP: 95, PDP: 88, NNPP: 4 };
const before = await (await fetch(base + "/api/ledger?limit=1000")).json();

for (const [i, t] of [[1, A], [2, A], [3, { ...A }], [4, { ...A, LP: 59 }]].entries()) {
  const r = await post("/api/reports", { channel: "web", handle: `e2e-${pu}-${i}`, puCode: pu, race: "president", tally: t[1] });
  check(r.status === 201, `report ${i + 1} accepted`, String(r.status));
}
let r = await post("/api/pipeline/unit", { puCode: pu, race: "president" });
let j = await r.json();
check(j.status === "low" || j.status === "medium" || j.status === "high", "pipeline ran", JSON.stringify({ status: j.status, share: j.share, reports: j.reports }));
check(j.status === "medium" && j.ledger === null, "3 of 4 agree (75%) → medium, NOT in ledger");

for (const k of [5, 6, 7, 8]) await post("/api/reports", { channel: "telegram", handle: `e2e-${pu}-${k}`, puCode: pu, race: "president", tally: A });
j = await (await post("/api/pipeline/unit", { puCode: pu, race: "president" })).json();
check(j.status === "high" && j.ledger?.seq === before.count + 1, "7 of 8 agree (87.5%) → high, appended to ledger", JSON.stringify(j.ledger));

j = await (await post("/api/pipeline/unit", { puCode: pu, race: "president" })).json();
check(j.ledger === null, "re-running an unchanged unit does not duplicate the ledger entry");

r = await post("/api/pipeline/unit", { puCode: pu, race: "president" }, { "content-type": "application/json" });
check(r.status === 401, "pipeline without token rejected", String(r.status));

const after = await (await fetch(base + "/api/ledger?limit=1000")).json();
const ordered = after.entries.sort((a, b) => a.seq - b.seq);
const v = await verifyChain(ordered, after.genesis);
check(ordered.length > 0 && v.ok && after.head === ordered.at(-1)?.hash, "full chain verifies from genesis to head", `${ordered.length} entries`);
const tampered = ordered.map((e) => (e.pu_code === pu ? { ...e, tally: { ...e.tally, APC: 999 } } : e));
check(!(await verifyChain(tampered, after.genesis)).ok, "tampering with the new entry is detected");

const res = await (await fetch(base + "/api/results?race=president")).json();
check(res.byState["NG-LA"]?.totals?.APC >= 120 && res.units.reported >= 1, "results API aggregates Lagos", JSON.stringify(res.byState["NG-LA"]?.leader));
process.exit(fail ? 1 : 0);
