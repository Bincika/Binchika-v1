// POST /api/pipeline/official {puCode, race, tally, documentUrl, source?} — record an official (IReV/INEC) polling-unit
// result and re-run the unit, so the citizen tally is compared with it (session 88; docs/protocol/IREV-COMPARISON.md).
// Bearer INGEST_TOKEN only. INEC publishes IReV result sheets as documents, not as an API, so an operator or a reader
// transcribes each one with its document link; nothing here scrapes INEC. A difference is stored on the unit and on its
// next ledger entry and shown to verifiers; it does not block the citizen tally (constitution §4).
import { processUnit } from "../../_lib/pipeline.js";
import { puProblem, NOT_A_PARTY } from "../../_lib/ec8a.js";
import { methodNotAllowed } from "../../_lib/http.js";

const RACES = ["president", "senate", "house", "governor", "state-assembly"];

async function authorised(request, env) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([request.headers.get("authorization") ?? "", `Bearer ${env.INGEST_TOKEN ?? ""}`].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let d = env.INGEST_TOKEN ? 0 : 1;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** Validates an official result. Pure; exported for tests. */
export function parseOfficial(body) {
  const errors = [];
  const why = puProblem(body?.puCode);
  if (why) errors.push(`puCode: ${why}`);
  if (!RACES.includes(body?.race)) errors.push(`race must be one of ${RACES.join(", ")}`);
  const source = body?.source ?? "IReV";
  if (!["IReV", "INEC"].includes(source)) errors.push("source must be IReV or INEC");
  let url = null;
  try { url = new URL(String(body?.documentUrl ?? "")); } catch {}
  if (!url || url.protocol !== "https:" || String(body.documentUrl).length > 500) errors.push("documentUrl must be the https link of the official document");
  const tally = {};
  if (!body?.tally || typeof body.tally !== "object" || Array.isArray(body.tally) || !Object.keys(body.tally).length) errors.push("tally must be an object of PARTY: votes");
  else for (const [k, v] of Object.entries(body.tally)) {
    if (!/^[A-Z]{1,6}$/i.test(k) || NOT_A_PARTY.test(k.toUpperCase())) errors.push(`bad party acronym "${k}"`);
    else if (!Number.isInteger(v) || v < 0 || v > 5000) errors.push(`votes for ${k} must be an integer 0–5000`);
    else tally[k.toUpperCase()] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { puCode: body.puCode, race: body.race, source, documentUrl: String(body.documentUrl), tally } };
}

export async function onRequestPost({ request, env }) {
  if (!(await authorised(request, env))) return Response.json({ error: "unauthorised" }, { status: 401 });
  if (!env.DB) return Response.json({ error: "database not bound" }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > 8192) return Response.json({ error: "payload too large" }, { status: 413 });
  const p = parseOfficial(await request.json().catch(() => null));
  if (!p.ok) return Response.json({ errors: p.errors }, { status: 422 });
  const v = p.value;
  await env.DB.prepare(`INSERT INTO official_results (pu_code, race, source, tally_json, document_url, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (pu_code, race, source) DO UPDATE SET tally_json = excluded.tally_json, document_url = excluded.document_url, fetched_at = excluded.fetched_at`)
    .bind(v.puCode, v.race, v.source, JSON.stringify(v.tally), v.documentUrl).run();
  const out = await processUnit(env.DB, v.puCode, v.race);
  return Response.json({ recorded: true, unit: { status: out.consensus.status, posted: Boolean(out.ledgerEntry) }, irev: out.discrepancy ?? { match: null, note: "no high citizen tally to compare yet" } });
}

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
