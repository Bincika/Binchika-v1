// GET /api/portal/reports — incoming citizen reports for the signed-in verifier's own area only.
// Reporter identities are never returned (not even their hashes).
import { userFromRequest, verifierFor, rest, supaConfigured, json } from "../../_lib/supa.js";
import { INEC_STATE_CODE } from "../../_lib/results.js";
import { mediaKeyOf } from "../../_lib/evidence.js";
import { STATUS_LABEL } from "../../_lib/ec8a.js";

export async function onRequestGet({ request, env }) {
  if (!supaConfigured(env)) return json({ error: "verifier system not configured (Supabase keys)" }, 503);
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "sign in required" }, 401);
  const me = await verifierFor(env, user.id);
  if (!me) return json({ error: "not a verifier" }, 403);

  let states = [];
  if (me.role === "szv") states = [me.state_iso];
  else if (me.role === "nrv") states = (await rest(env, `region_states?region_id=eq.${encodeURIComponent(me.region_id)}&select=state_iso`)).map((r) => r.state_iso);
  else states = Object.values(INEC_STATE_CODE);
  const codes = Object.entries(INEC_STATE_CODE).filter(([, iso]) => states.includes(iso)).map(([c]) => c);
  if (!codes.length) return json({ reports: [] });

  // Session 88: each reading carries its control-total check, the OCR proposal (if the contained OCR path produced one)
  // and the unit's consensus, IReV difference and posting gates, so a verifier can decide from one screen.
  const q = `SELECT r.id, r.channel, r.pu_code, r.race, r.status, r.tally_json, r.evidence, r.audit_status, r.audited_by, r.audit_note, r.media_ref, r.media_sha256, r.face_check, r.received_at,
      c.controls_json, c.checks_ok, c.checks_json, c.ocr_status, c.ocr_json,
      u.status AS unit_status, u.share AS unit_share, u.reports AS unit_reports, u.discrepancy_json, u.gates_json
    FROM reports r LEFT JOIN report_checks c ON c.report_id = r.id LEFT JOIN unit_consensus u ON u.pu_code = r.pu_code AND u.race = r.race
    WHERE substr(r.pu_code, 1, 2) IN (${codes.map(() => "?").join(",")}) ORDER BY r.received_at DESC LIMIT 200`;
  const { results } = await env.DB.prepare(q).bind(...codes).all();
  const j = (t) => (t ? JSON.parse(t) : null);
  return json({ me: { publicId: me.public_id, role: me.role, states }, reports: results.map((r) => {
    const ocr = j(r.ocr_json);
    return {
      id: r.id, channel: r.channel, pu_code: r.pu_code, race: r.race, status: r.status, status_label: STATUS_LABEL[r.status] ?? r.status,
      evidence: r.evidence, audit_status: r.audit_status, audited_by: r.audited_by, audit_note: r.audit_note, media_sha256: r.media_sha256, face_check: r.face_check, received_at: r.received_at,
      tally: j(r.tally_json), has_media: Boolean(mediaKeyOf(r.media_ref)),
      controls: j(r.controls_json), balanced: r.checks_ok === 1, problems: j(r.checks_json) ?? [],
      ocr: ocr ? { status: r.ocr_status, model: ocr.model, transcript: ocr.transcript, fields: ocr.fields, confidence: ocr.confidence, reason: ocr.reason } : (r.ocr_status ? { status: r.ocr_status } : null),
      unit: r.unit_status ? { status: r.unit_status, share: r.unit_share, reports: r.unit_reports, irev: j(r.discrepancy_json), gates: j(r.gates_json) } : null,
    };
  }) });
}
