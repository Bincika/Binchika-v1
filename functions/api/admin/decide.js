// POST /api/admin/decide {flagId, decision: "approve"|"reject", tally?, note}
// BinchikAdmin (role key superadmin) only. Approving writes a CORRECTION entry to the hash-chained ledger (history is never edited),
// referencing the flag and the public IDs involved — never a person.
import { requireAdmin, rest, json } from "../../_lib/supa.js";
import { recordCorrection } from "../../_lib/pipeline.js";
import { methodNotAllowed } from "../../_lib/http.js";

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
    const prev = await env.DB.prepare("SELECT ledger_hash FROM unit_consensus WHERE pu_code = ?1 AND race = ?2").bind(flag.pu_code, flag.race).first();
    entry = await recordCorrection(env.DB, {
      puCode: flag.pu_code, race: flag.race, tally, flagId: flag.id,
      reason: `${note} (raised by ${flag.raised_by_public_id ?? "?"}, reviewed by ${flag.nrv_public_id ?? "?"}, approved by ${me.public_id})`,
      supersedes: prev?.ledger_hash ?? null,
    });
  }
  await rest(env, `discrepancy_flags?id=eq.${flagId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: decision === "approve" ? "approved" : "rejected", decision_note: note, decided_by: user.id, decided_at: new Date().toISOString() }),
  });
  return json({ ok: true, decision, ledger: entry ? { seq: entry.seq, hash: entry.hash } : null });
}

// GET is not a read here: answer 405 instead of falling through to the home page (session 90; functions/_lib/http.js).
export const onRequestGet = () => methodNotAllowed("POST");
