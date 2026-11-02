// Validation + normalisation for incoming citizen reports. Pure; shared by API routes and tests.
import { sha256Hex } from "./ledger.js";
import { puProblem, NOT_A_PARTY } from "./ec8a.js";

export const CHANNELS = ["telegram", "whatsapp", "x", "instagram", "threads", "discord", "web", "sms", "other"];
export const RACES = ["president", "senate", "house", "governor", "state-assembly"];
// INEC polling-unit code: state-lga-ward-unit, e.g. 24-09-05-012
const PU = /^\d{2}-\d{2}-\d{2}-\d{3}$/;
const MAX_VOTES = 5000; // far above any single polling unit's register; rejects obvious junk
// What the report shows. "ec8a" is the posted result sheet (the default). The others are the alternatives accepted when
// Form EC8A is not available: they wait for a verifier's audit and can never make a unit high-confidence on their own
// (consensus.js unitConsensus; docs/EVIDENCE-AUDIT.md).
export const EVIDENCE = ["ec8a", "video", "handwritten", "board"];
export const isLowerEvidence = (evidence) => (evidence ?? "ec8a") !== "ec8a";

export async function hashReporter(salt, channel, handle) {
  if (!salt || salt.length < 16) throw new Error("REPORTER_HASH_SALT missing or too short");
  return sha256Hex(`${salt}:${channel}:${String(handle).trim().toLowerCase()}`);
}

/** Returns { ok: true, value } or { ok: false, errors: string[] }. Never echoes the handle back. */
export function parseReport(body) {
  const errors = [];
  if (!body || typeof body !== "object") return { ok: false, errors: ["body must be a JSON object"] };
  const { channel, handle, puCode, race, mediaRef, mediaSha256, caption, tally, evidence = "ec8a", controls } = body;
  if (!CHANNELS.includes(channel)) errors.push(`channel must be one of ${CHANNELS.join(", ")}`);
  if (!handle || String(handle).length > 200) errors.push("handle is required (it is hashed, never stored)");
  // Session 88: positional check (state 01–37, an LGA that exists in that state, non-zero ward and unit); INEC codes
  // carry no check digit. 00-00-00-000 and 99-99-99-999 are refused.
  if (puCode != null) { const why = puProblem(puCode); if (why) errors.push(PU.test(puCode) ? `puCode: ${why}` : "puCode must look like 24-09-05-012"); }
  if (race != null && !RACES.includes(race)) errors.push(`race must be one of ${RACES.join(", ")}`);
  if (mediaSha256 != null && !/^[a-f0-9]{64}$/.test(mediaSha256)) errors.push("mediaSha256 must be 64 hex chars");
  if (caption != null && String(caption).length > 2000) errors.push("caption too long");
  if (!EVIDENCE.includes(evidence)) errors.push(`evidence must be one of ${EVIDENCE.join(", ")}`);
  let cleanTally = null;
  if (tally != null) {
    if (typeof tally !== "object" || Array.isArray(tally)) errors.push("tally must be an object of PARTY: votes");
    else {
      cleanTally = {};
      for (const [k, v] of Object.entries(tally)) {
        const n = Number(v);
        if (!/^[A-Z]{1,6}$/i.test(k)) errors.push(`bad party acronym "${k}"`);
        else if (NOT_A_PARTY.test(k.toUpperCase())) errors.push(`"${k}" is not a party: void ballots go in controls.rejected, never in a party`);
        else if (!Number.isInteger(n) || n < 0 || n > MAX_VOTES) errors.push(`votes for ${k} must be an integer 0–${MAX_VOTES}`);
        else cleanTally[k.toUpperCase()] = n;
      }
    }
  }
  // Form EC8A control totals (session 88), optional at ingest: without them a reading can be stored but never posted.
  let cleanControls = null;
  if (controls != null) {
    if (typeof controls !== "object" || Array.isArray(controls)) errors.push("controls must be an object");
    else {
      cleanControls = {};
      for (const k of ["register", "accredited", "rejected", "spoiled", "valid", "cast"]) {
        if (controls[k] == null) continue;
        const n = Number(controls[k]);
        if (!Number.isInteger(n) || n < 0 || n > 100000) errors.push(`controls.${k} must be an integer 0–100000`);
        else cleanControls[k] = n;
      }
      if (controls.cancelled != null) { if (typeof controls.cancelled !== "boolean") errors.push("controls.cancelled must be true or false"); else cleanControls.cancelled = controls.cancelled; }
      const extra = Object.keys(controls).filter((k) => !["register", "accredited", "rejected", "spoiled", "valid", "cast", "cancelled"].includes(k));
      if (extra.length) errors.push(`unknown controls: ${extra.join(", ")}`);
      if (cleanControls.cancelled && cleanTally && Object.keys(cleanTally).length) errors.push("a cancelled polling unit has no tally");
    }
  }
  if (!mediaRef && !cleanTally) errors.push("send a photo reference (mediaRef) or a tally");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { channel, handle: String(handle), puCode: puCode ?? null, race: race ?? null, mediaRef: mediaRef ?? null, mediaSha256: mediaSha256 ?? null, caption: caption ?? null, tally: cleanTally, evidence, controls: cleanControls },
  };
}

/** Extracts a report candidate from a Telegram update (photo or document image). */
export function parseTelegramUpdate(update) {
  const msg = update?.message ?? update?.channel_post;
  if (!msg) return null;
  const from = msg.from?.id ?? msg.chat?.id;
  const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const doc = msg.document && /^image\//.test(msg.document.mime_type ?? "") ? msg.document : null;
  const file = photo ?? doc;
  const caption = msg.caption ?? msg.text ?? null;
  const pu = caption?.match(/\b\d{2}-\d{2}-\d{2}-\d{3}\b/)?.[0] ?? null;
  return { chatId: msg.chat?.id, handle: from != null ? `tg:${from}` : null, mediaRef: file ? `tg-file:${file.file_id}` : null, caption, puCode: pu };
}
