// POST /api/admin/decide {flagId, decision: "approve"|"reject", tally?, note}
// BinchikAdmin (role key superadmin) only. Approving writes a CORRECTION entry to the hash-chained ledger (history is never edited),
// referencing the flag and the public IDs involved — never a person.
import { requireAdmin, rest, json } from "../../_lib/supa.js";
import { recordCorrection } from "../../_lib/pipeline.js";
import { methodNotAllowed } from "../../_lib/http.js";
import { checkTally } from "../../_lib/report.js";
import { checkAgainstBaseline } from "../../_lib/baseline.js";

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);   // BinchikAdmin + MFA (aal2)
  if (gate instanceof Response) return gate;
  const { user, me } = gate;

  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const { flagId, decision, note } = body ?? {};
  if (!/^[0-9a-f-]{36}$/.test(flagId ?? "") || !["approve", "reject"].includes(decision) || String(note ?? "").length < 10) {
    return json({ error: "flagId, decision (approve|reject) and a note of at least 10 characters are required" }, 422);
  }
  const [flag] = await rest(env, `discrepancy_flags?id=eq.${flagId}&select=id,pu_code,race,status,proposed_tally,raised_by_public_id,nrv_public_id`);
  if (!flag) return json({ error: "flag not found" }, 404);
  if (!["escalated", "investigating", "ai_done"].includes(flag.status)) return json({ error: `flag is ${flag.status}; it must be escalated by an NRV first` }, 409);

  let entry = null;
  if (decision === "approve") {
    // Three separate seats (session 76): the raiser, a different Regional Verifier who acted on the flag, and the approver.
    // nrv_public_id is stamped only by an NRV's own update (guard_flag_update) and is not client-writable.
    const ids = [flag.raised_by_public_id, flag.nrv_public_id, me.public_id];
    if (ids.some((x) => !x) || new Set(ids).size !== 3) {
      return json({ error: "a correction needs three separate seats: the verifier who raised the flag, a different Regional Verifier, and the BinchikAdmin" }, 409);
    }
    const tally = body.tally ?? flag.proposed_tally;
    if (!tally || typeof tally !== "object") return json({ error: "approving needs a corrected tally (from AI re-investigation or supplied)" }, 422);
    // Session 196 (build-plan-6): a correction may change only a posted result. Posted = status high with a ledger hash;
    // the hash alone is not enough, because pipeline.js keeps an old hash when a unit falls back to held. Nobody, the
    // BinchikAdmin included, may post a unit past the posting gates (owner decision 1, session 188). Nothing is written.
    const prev = await env.DB.prepare("SELECT status, ledger_hash FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").bind(flag.pu_code, flag.race).first();
    if (prev?.status !== "high" || !prev?.ledger_hash) {
      return json({ error: "a correction can only change a posted result; this unit is not on the ledger" }, 409);
    }
    // Session 200 (build-plan-7): the corrected figures are checked before anything is written. Shape: the intake rules
    // (checkTally). Register: the votes may not exceed the largest register printed on the unit's counted sheets — the
    // same sheets processUnit counts (pipeline.js). A misread high register is the accepted residual risk; the three-seat
    // approval is the check on it. With no register on any counted sheet, the register check is skipped, as in processUnit.
    const checked = checkTally(tally);
    if (checked.errors.length) return json({ error: `the corrected figures are not valid: ${checked.errors[0]}` }, 422);
    const { results: sheets } = await env.DB.prepare(
      `SELECT c.controls_json FROM reports r JOIN report_checks c ON c.report_id = r.id
        WHERE r.pu_code = ?1 AND r.race = ?2 AND r.tally_json IS NOT NULL AND r.status <> 'rejected'
          AND COALESCE(r.audit_status, '') <> 'rejected' AND r.status IN ('ocr_done','verified')
          AND COALESCE(r.evidence, 'ec8a') = 'ec8a'`,
    ).bind(flag.pu_code, flag.race).all();
    const registers = sheets.map((s) => (s.controls_json ? JSON.parse(s.controls_json).register : null)).filter((n) => Number.isInteger(n));
    if (registers.length) {
      const votes = Object.values(checked.value).reduce((a, n) => a + n, 0);
      const b = checkAgainstBaseline(Math.max(...registers), { votesCast: votes });
      if (b.findings.some((f) => f.field === "votesCast")) {
        return json({ error: "the corrected votes exceed the register printed on this unit's sheets" }, 409);
      }
    }
    // Build plan 8 (correction-path hardening): one correction per flag, written only if the unit is still posted with the
    // hash read above, in one D1 batch. Until the migration exists (previews share the production database) approving is
    // refused with 503 and nothing is written; rejecting stays available below.
    const out = await recordCorrection(env.DB, {
      puCode: flag.pu_code, race: flag.race, tally: checked.value, flagId: flag.id,
      reason: `${note} (raised by ${flag.raised_by_public_id ?? "?"}, reviewed by ${flag.nrv_public_id ?? "?"}, approved by ${me.public_id})`,
      supersedes: prev?.ledger_hash ?? null,
      expectedHash: prev.ledger_hash,
    });
    if (out.refused === "not_ready") return json({ error: "corrections are being upgraded; nothing was written. Try again after the upgrade." }, 503);
    if (out.refused === "busy") return json({ error: "the ledger is busy; nothing was written. Try again." }, 503);
    if (out.refused === "unit_changed") return json({ error: "the unit changed while you were deciding; nothing was written. Reload and decide again." }, 409);
    if (out.refused === "already_decided") {
      // Gate 1, F5: the D1 write committed earlier but the flag update did not. Update the flag only; write nothing new.
      const claim = await env.DB.prepare("SELECT ledger_hash FROM correction_claims WHERE flag_id = ?1").bind(flag.id).first();
      const rows = await patchFlag(env, flagId, decided(user, note, "approved"), true);
      if (!claim || !rows?.length) return json({ error: "this flag has already been decided" }, 409);
      return json({ ok: true, decision, ledger: { hash: claim.ledger_hash }, warning: "flag updated on retry" });
    }
    entry = out.entry;
    // The flag update is conditional, so a flag decided elsewhere meanwhile is not overwritten. The correction stands
    // either way; the admin list "Corrections to check" shows any claim whose flag is not approved.
    const rows = await patchFlag(env, flagId, decided(user, note, "approved"), true);
    const res = { ok: true, decision, ledger: { seq: entry.seq, hash: entry.hash } };
    return json(rows?.length ? res : { ...res, warning: "flag already updated" });
  }
  await patchFlag(env, flagId, decided(user, note, "rejected"), false);   // rejecting: as before
  return json({ ok: true, decision, ledger: null });
}

const decided = (user, note, status) => ({ status, decision_note: note, decided_by: user.id, decided_at: new Date().toISOString() });
const patchFlag = (env, flagId, body, onlyIfOpen) =>
  rest(env, `discrepancy_flags?id=eq.${flagId}${onlyIfOpen ? "&status=in.(escalated,investigating,ai_done)" : ""}`, { method: "PATCH", body: JSON.stringify(body) });

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
