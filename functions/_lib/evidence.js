// Verifier audit of alternative evidence (used when Form EC8A is not available: a video, handwritten numbers or a photo
// of the results board). An SZV or NRV for the unit's state approves or rejects it with a reason someone else can check;
// the unit is then re-evaluated. Approved evidence can make a unit "lower" (lower-confidence) at most, never "high"
// (unitConsensus in consensus.js). Used by POST /api/portal/evidence. Session 55; docs/EVIDENCE-AUDIT.md.
import { isLowerEvidence } from "./report.js";
import { stateOfPu } from "./results.js";
import { processUnit } from "./pipeline.js";

export const AUDIT_DECISIONS = ["approved", "rejected"];
const no = (status, error) => ({ status, body: { error } });

/**
 * @param {{ reportId: string, decision: string, note: string }} input
 * @param {{ role: string, public_id: string, states: string[] }} verifier  the signed-in, active verifier and the states in view
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function auditEvidence(db, input, verifier) {
  if (!verifier || !["szv", "nrv"].includes(verifier.role)) return no(403, "Only a State Zone Verifier or Regional Verifier can audit evidence.");
  if (!AUDIT_DECISIONS.includes(input?.decision)) return no(422, "decision must be approved or rejected");
  const note = String(input?.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length < 10 || note.length > 500) return no(422, "Give a reason someone else can check (10–500 characters).");
  const r = await db.prepare("SELECT id, pu_code, race, evidence, audit_status FROM reports WHERE id = ?1").bind(String(input?.reportId ?? "")).first();
  if (!r) return no(404, "report not found");
  if (!isLowerEvidence(r.evidence)) return no(409, "Only alternative evidence needs an audit; result-sheet reports go through normal consensus.");
  if (r.audit_status !== "pending") return no(409, "This evidence has already been audited.");
  if (!verifier.states.includes(stateOfPu(r.pu_code))) return no(403, "You can only audit evidence from your own state (SZV) or region (NRV).");
  const done = await db.prepare(
    "UPDATE reports SET audit_status = ?2, audited_by = ?3, audit_note = ?4, audited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND audit_status = 'pending'"
  ).bind(r.id, input.decision, verifier.public_id, note).run();
  if (!done.meta?.changes) return no(409, "This evidence has already been audited.");
  const unit = r.pu_code && r.race ? await processUnit(db, r.pu_code, r.race) : null;
  return {
    status: 200,
    body: { ok: true, id: r.id, audit: input.decision, auditedBy: verifier.public_id, unit: unit ? { status: unit.consensus.status, evidence: unit.consensus.evidence, ledger: Boolean(unit.ledgerEntry) } : null },
  };
}

// ---------- Evidence viewer (session 57): signed-in SZV/NRV with MFA, own state/region only ----------
// Media is served only from the private R2 bucket, only under full/ (where processed evidence will be kept once the
// photo pipeline exists; never mail/ or tmp/), only as an image or video type, and never to the public.
export const MEDIA_TYPES = /^(image\/(jpeg|png|webp)|video\/(mp4|webm))$/;
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** The R2 key a report's media_ref points at ("r2:full/…"), or null if it is not viewable evidence. */
export function mediaKeyOf(mediaRef) {
  const m = /^r2:(full\/[A-Za-z0-9_\-./]{1,200})$/.exec(String(mediaRef ?? ""));
  return m && !m[1].split("/").some((part) => part === "" || part === "." || part === "..") ? m[1] : null;
}

/**
 * Finds the stored media for one report, for a verifier who may see it.
 * @param {{ role: string, public_id: string, states: string[], aal?: string }} verifier
 * @returns {Promise<{ status: number, body?: object, object?: R2ObjectBody, report?: object }>}
 */
export async function evidenceMedia(db, bucket, reportId, verifier) {
  if (!verifier || !["szv", "nrv"].includes(verifier.role)) return no(403, "Only a State Zone Verifier or Regional Verifier can view evidence.");
  if (verifier.aal !== "aal2") return { status: 403, body: { error: "Viewing evidence needs your authenticator app: verify first.", mfa: true } };
  const r = await db.prepare("SELECT id, pu_code, evidence, media_ref, media_sha256, face_check FROM reports WHERE id = ?1").bind(String(reportId ?? "")).first();
  if (!r) return no(404, "report not found");
  if (!verifier.states.includes(stateOfPu(r.pu_code))) return no(403, "You can only view evidence from your own state (SZV) or region (NRV).");
  const key = mediaKeyOf(r.media_ref);
  if (!key) return no(409, "This report has no stored evidence to view yet.");
  const object = await bucket?.get(key);
  if (!object) return no(404, "The evidence file was not found.");
  const type = object.httpMetadata?.contentType ?? "";
  if (!MEDIA_TYPES.test(type)) return no(415, "This file type is not shown in the viewer.");
  if (object.size > MAX_MEDIA_BYTES) return no(413, "This file is too large for the viewer.");
  return { status: 200, object, report: r, type };
}
