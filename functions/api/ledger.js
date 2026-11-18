// GET /api/ledger?after=<seq>&limit=<n> — public ledger entries (append-only, hash-chained).
// Session 184 (docs/egm/audit-fixes/build-plan-5.md; snapshot-only-read.md steps B and C): read through the shared edge
// cache with bounded keys, and count from the head instead of scanning the table.
//  - count = the head's seq: seq is the INTEGER PRIMARY KEY, set only by appendEntry as head.seq + 1, never updated or
//    deleted (db/d1/0002_ledger.sql), so it has no gaps and equals the number of entries.
//  - limit becomes 100, 500 or 1000 (rounded up; default 500); after is clamped to the head, so every value past the end
//    shares one key and walking `after` cannot force fresh reads beyond the real ledger.
//  - entries and head are read in one batch, so head and count agree with the entries served.
//  - a missing database is answered but never stored; a failing query is a 503, never stored.
import { TENANT } from "../_lib/tenant.generated.js";   // body name (session 98)
import { CYCLE } from "../_lib/pipeline.js";
import { genesis } from "../_lib/ledger.js";
import { readThroughCache } from "../_lib/edge-cache.js";

const LEDGER_CACHE_SECONDS = 10;
const LIMITS = [100, 500, 1000];
const HEAD_SQL = "SELECT seq, hash FROM ledger_entries ORDER BY seq DESC LIMIT 1";
const ENTRIES_SQL = "SELECT body_json, hash FROM ledger_entries WHERE seq > ?1 ORDER BY seq LIMIT ?2";
const json = (data, status, cacheControl) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cacheControl } });
const unavailable = () => json({ error: "ledger temporarily unavailable" }, 503, "no-store");
const failed = (stage) => console.log(JSON.stringify({ event: "ledger-read-failed", stage }));

export function normaliseLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 500;
  return LIMITS.find((l) => n <= l) ?? 1000;
}
const cleanAfter = (raw) => Math.max(0, Number(raw ?? 0) | 0);

export async function onRequestGet({ request, env, waitUntil }) {
  const url = new URL(request.url);
  const limit = normaliseLimit(url.searchParams.get("limit"));
  const asked = cleanAfter(url.searchParams.get("after"));

  // The head, for clamping: its own fixed key, so it is read at most once per 10 s per data centre.
  const headRes = await readThroughCache({ key: new Request(`${url.origin}/api/ledger?head`), waitUntil, build: () => readHead(env) });
  if (!headRes.ok) return unavailable();
  let H;
  try { H = (await headRes.json()).seq; } catch { return unavailable(); }
  if (!Number.isSafeInteger(H) || H < 0) return unavailable();

  const after = Math.min(asked, H);
  return readThroughCache({ key: new Request(`${url.origin}/api/ledger?after=${after}&limit=${limit}`), waitUntil, build: () => readPage(env, after, limit) });
}

async function readHead(env) {
  if (!env.DB) return { response: json({ seq: 0 }, 200, `public, max-age=${LEDGER_CACHE_SECONDS}`), store: false };
  try {
    const row = await env.DB.prepare(HEAD_SQL).first();
    return { response: json({ seq: row?.seq ?? 0 }, 200, `public, max-age=${LEDGER_CACHE_SECONDS}`), store: true };
  } catch { failed("head"); return { response: unavailable(), store: false }; }
}

async function readPage(env, after, limit) {
  const g = await genesis(CYCLE);
  const notice = `Citizen-verified tallies. Not official results. Only ${TENANT.electoralBody.short} declares results.`;
  if (!env.DB) return { response: json({ cycle: CYCLE, genesis: g, head: g, count: 0, entries: [], notice }, 200, `public, max-age=${LEDGER_CACHE_SECONDS}`), store: false };
  let page, head;
  try {
    const [p, h] = await env.DB.batch([env.DB.prepare(ENTRIES_SQL).bind(after, limit), env.DB.prepare(HEAD_SQL)]);
    page = p.results; head = h.results[0] ?? { seq: 0, hash: g };
  } catch { failed("entries"); return { response: unavailable(), store: false }; }
  const body = {
    cycle: CYCLE, genesis: g, head: head.hash, count: head.seq,
    entries: page.map((r) => ({ ...JSON.parse(r.body_json), hash: r.hash })),
    notice,
  };
  return { response: json(body, 200, `public, max-age=${LEDGER_CACHE_SECONDS}`), store: true };
}
