// Verifier confirmation of a Form EC8A reading (session 88; docs/protocol/AI-GOVERNANCE.md). A result-sheet reading,
// typed by a reporter or proposed by OCR, counts toward consensus only after an SZV or NRV for the unit's state has
// looked at the photo and confirmed it. Confirm or reject only: a verifier never edits the numbers, so no single person
// can rewrite readings to manufacture agreement. Corrected control totals may be supplied, and must balance.
// Impersonation hardening: signed-in, active seat, own state or region, and an authenticator-verified session (AAL2).
import { stateOfPu } from "./results.js";
import { processUnit } from "./pipeline.js";
import { assessControls } from "./ec8a.js";

export const REVIEW_DECISIONS = ["confirm", "reject"];
const no = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

/**
 * @param {{ reportId: string, decision: string, note: string, controls?: object }} input
 * @param {{ role: string, public_id: string, states: string[], aal?: string }} verifier
 */
export async function reviewReading(db, input, verifier) {
  if (!verifier || !["szv", "nrv"].includes(verifier.role)) return no(403, "Only a State Zone Verifier or Regional Verifier can confirm a reading.");
  if (verifier.aal !== "aal2") return no(403, "Confirming a reading needs your authenticator app: verify first.", { mfa: true });
  if (!REVIEW_DECISIONS.includes(input?.decision)) return no(422, "decision must be confirm or reject");
  const note = String(input?.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length < 10 || note.length > 500) return no(422, "Give a reason someone else can check (10–500 characters).");
  const r = await db.prepare("SELECT r.id, r.pu_code, r.race, r.evidence, r.status, r.tally_json, c.controls_json, c.checks_ok FROM reports r LEFT JOIN report_checks c ON c.report_id = r.id WHERE r.id = ?1")
    .bind(String(input?.reportId ?? "")).first();
  if (!r) return no(404, "report not found");
  if ((r.evidence ?? "ec8a") !== "ec8a") return no(409, "Alternative evidence is audited separately (Approve or Reject on the evidence).");
  if (r.status !== "needs_review") return no(409, "Only a reading that needs a check can be confirmed or rejected.");
  if (!r.tally_json) return no(409, "There is no reading to confirm yet.");
  if (!verifier.states.includes(stateOfPu(r.pu_code))) return no(403, "You can only check readings from your own state (SZV) or region (NRV).");

  let controls = r.controls_json ? JSON.parse(r.controls_json) : null;
  let checks = { ok: r.checks_ok === 1, errors: [] };
  if (input.decision === "confirm") {
    if (input.controls != null) {
      if (typeof input.controls !== "object" || Array.isArray(input.controls)) return no(422, "controls must be an object");
      controls = {};
      for (const k of ["register", "accredited", "rejected", "spoiled", "valid", "cast"]) if (input.controls[k] != null) controls[k] = Number(input.controls[k]);
      if (input.controls.cancelled === true) controls.cancelled = true;
    }
    checks = assessControls(controls, JSON.parse(r.tally_json));
    if (!checks.ok) return no(422, "The sheet does not balance, so it cannot be confirmed. Enter the control totals from the photo, or reject it.", { problems: checks.errors });
  }
  const done = await db.prepare("UPDATE reports SET status = ?2, audited_by = ?3, audit_note = ?4, audited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND status = 'needs_review'")
    .bind(r.id, input.decision === "confirm" ? "verified" : "rejected", verifier.public_id, note).run();
  if (!done.meta?.changes) return no(409, "This reading has already been checked.");
  if (input.decision === "confirm") {
    await db.prepare(`INSERT INTO report_checks (report_id, controls_json, checks_ok, checks_json, updated_at) VALUES (?1, ?2, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT (report_id) DO UPDATE SET controls_json = excluded.controls_json, checks_ok = 1, checks_json = NULL, updated_at = excluded.updated_at`).bind(r.id, JSON.stringify(controls)).run();
  }
  const unit = r.pu_code && r.race ? await processUnit(db, r.pu_code, r.race) : null;
  return {
    status: 200,
    body: { ok: true, id: r.id, decision: input.decision, checkedBy: verifier.public_id,
      unit: unit ? { status: unit.consensus.status, posted: Boolean(unit.ledgerEntry), gates: unit.gates.gates.filter((g) => !g.pass).map((g) => g.id) } : null },
  };
}
