// Contained OCR for Form EC8A photos (session 88; docs/protocol/OCR.md). Off unless OCR_ENGINE = "workers-ai" and the
// Workers AI binding (AI) exists. It follows the AI constitution (docs/protocol/AI-GOVERNANCE.md):
// - suggest, never decide: a reading is only ever a PROPOSAL; it never counts until a verifier confirms it;
// - no faces: it runs only on photos the people check has cleared ("none"); "unchecked" and "detected" are withheld;
// - say how sure it is: per-field confidence is kept, and anything below 0.9 is flagged for the verifier;
// - fail closed: engine errors, unreadable output or a missing field mean "withheld", never a guess;
// - auditable: model, input SHA-256 and time are logged with the transcript; kill switch: OCR_ENGINE = "off".
// The Windows reader in sandbox/readiness/ stays a local instrument only.
import { sha256Hex } from "./ledger.js";

export const OCR_DEFAULT_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
export const FIELD_CONFIDENCE_MIN = 0.9;
export const OCR_PROMPT = [
  "You are reading a photograph of a Nigerian INEC Form EC8A (polling-unit result sheet).",
  "Return ONLY one JSON object, no prose, with these keys:",
  '{"puCode":"SS-LL-WW-UUU","parties":{"ACRONYM":votes},"register":n,"accredited":n,"rejected":n,"valid":n,"cast":n,',
  '"confidence":{"puCode":0-1,"parties":0-1,"register":0-1,"accredited":0-1,"rejected":0-1},"transcript":"the figures as written"}',
  "Use whole numbers. If a figure is unreadable, use null and confidence 0. Do not guess. Do not add parties that are not on the sheet.",
].join("\n");

const withheld = (reason, extra = {}) => ({ status: "withheld", reason, ...extra });

/** First {...} object in the model text, or null. */
function firstJson(text) {
  const s = String(text ?? "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

/**
 * Turn model output into a checked proposal, or a withheld result. Pure; exported for tests.
 * @returns {{ status: "proposed"|"withheld", reason?: string, tally?: object, controls?: object, fields?: object[], confidence?: number, low?: string[], transcript?: string }}
 */
export function interpretOcr(text) {
  const o = firstJson(text);
  if (!o || typeof o !== "object") return withheld("The reader did not return a readable result.");
  const parties = o.parties && typeof o.parties === "object" && !Array.isArray(o.parties) ? o.parties : null;
  if (!parties || !Object.keys(parties).length) return withheld("No party figures were read.");
  const tally = {};
  for (const [k, v] of Object.entries(parties)) {
    if (!/^[A-Z]{1,6}$/i.test(k) || !Number.isInteger(v) || v < 0 || v > 5000) return withheld(`Party figure "${k}" is not a clean whole number.`);
    tally[k.toUpperCase()] = v;
  }
  const controls = {};
  for (const k of ["register", "accredited", "rejected", "valid", "cast"]) if (Number.isInteger(o[k]) && o[k] >= 0) controls[k] = o[k];
  const conf = o.confidence && typeof o.confidence === "object" ? o.confidence : {};
  const fields = ["puCode", "parties", "register", "accredited", "rejected"].map((name) => ({ name, confidence: Math.max(0, Math.min(1, Number(conf[name]) || 0)) }));
  const low = fields.filter((f) => f.confidence < FIELD_CONFIDENCE_MIN).map((f) => f.name);
  return {
    status: "proposed", tally, controls,
    puCode: typeof o.puCode === "string" ? o.puCode.slice(0, 20) : null,
    fields, confidence: Math.min(...fields.map((f) => f.confidence)), low,
    transcript: String(o.transcript ?? "").slice(0, 2000),
  };
}

/**
 * Read one stored photo. Never throws; anything unexpected is "withheld".
 * @param {object} env  needs OCR_ENGINE = "workers-ai" and the AI binding; OCR_MODEL optional
 * @param {{ bytes: Uint8Array, faceCheck: string|null }} photo
 */
export async function readSheet(env, { bytes, faceCheck }) {
  if (String(env.OCR_ENGINE ?? "off") !== "workers-ai" || !env.AI) return { status: "off", reason: "OCR is switched off (OCR_ENGINE)." };
  if (faceCheck !== "none") return withheld("The photo has not been cleared by the people check, and no AI may see a face.");
  const model = String(env.OCR_MODEL || OCR_DEFAULT_MODEL);
  const inputSha256 = await sha256Hex(bytes);
  const at = new Date().toISOString();
  let out;
  try { out = await env.AI.run(model, { image: [...bytes], prompt: OCR_PROMPT, max_tokens: 700 }); }
  catch (e) { return withheld("The reader failed.", { model, inputSha256, at, error: String(e).slice(0, 160) }); }
  const r = interpretOcr(out?.response ?? out?.description ?? out);
  return { ...r, model, inputSha256, at, aiGenerated: true };
}

/**
 * Run the contained OCR on one report's stored photo and record the result (POST /api/pipeline/ocr).
 * A proposal fills in the reading only when the report has none yet, and always as "needs_review": it counts only after
 * a verifier confirms it (functions/_lib/review.js). It never writes the ledger, consensus or results.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function ocrReport(env, reportId, { assessControls }) {
  const r = await env.DB.prepare("SELECT id, status, evidence, media_ref, face_check, tally_json FROM reports WHERE id = ?1").bind(String(reportId ?? "")).first();
  if (!r) return { status: 404, body: { error: "report not found" } };
  if ((r.evidence ?? "ec8a") !== "ec8a") return { status: 409, body: { error: "OCR reads result sheets only." } };
  const key = /^r2:(full\/[A-Za-z0-9_\-./]{1,200})$/.exec(String(r.media_ref ?? ""))?.[1];
  if (!key || key.split("/").some((p) => p === "" || p === "." || p === "..")) return { status: 409, body: { error: "This report has no processed photo." } };
  let result;
  if (String(env.OCR_ENGINE ?? "off") !== "workers-ai" || !env.AI) result = { status: "off", reason: "OCR is switched off (OCR_ENGINE)." };
  else {
    const object = await env.EVIDENCE?.get(key);
    if (!object) return { status: 404, body: { error: "The photo was not found." } };
    if (!/^image\/(jpeg|png|webp)$/.test(object.httpMetadata?.contentType ?? "")) result = withheld("Only photos are read, not videos.");
    else result = await readSheet(env, { bytes: new Uint8Array(await object.arrayBuffer()), faceCheck: r.face_check });
  }
  const { tally, controls, ...meta } = result;
  await env.DB.prepare(`INSERT INTO report_checks (report_id, ocr_status, ocr_json, updated_at) VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT (report_id) DO UPDATE SET ocr_status = excluded.ocr_status, ocr_json = excluded.ocr_json, updated_at = excluded.updated_at`)
    .bind(r.id, result.status, JSON.stringify({ ...meta, tally: tally ?? null, controls: controls ?? null })).run();
  let filled = false;
  if (result.status === "proposed" && !r.tally_json && ["received", "ocr_pending"].includes(r.status)) {
    const checks = assessControls(Object.keys(controls).length ? controls : null, tally);
    const upd = await env.DB.prepare("UPDATE reports SET tally_json = ?2, status = 'needs_review' WHERE id = ?1 AND tally_json IS NULL AND status IN ('received','ocr_pending')").bind(r.id, JSON.stringify(tally)).run();
    filled = Boolean(upd.meta?.changes);
    if (filled) await env.DB.prepare("UPDATE report_checks SET controls_json = ?2, checks_ok = ?3, checks_json = ?4 WHERE report_id = ?1")
      .bind(r.id, Object.keys(controls).length ? JSON.stringify(controls) : null, checks.ok ? 1 : 0, checks.ok ? null : JSON.stringify(checks.errors)).run();
  }
  return { status: 200, body: { id: r.id, ocr: result.status, reason: result.reason ?? null, confidence: result.confidence ?? null, low: result.low ?? [], proposalFilled: filled, review: "a verifier must confirm any reading before it counts" } };
}
