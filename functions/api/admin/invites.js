// /api/admin/invites — BinchikAdmin + MFA only.
// GET: live invites, eligible applications (no names or emails), OpsAdmin seats and recent seat history.
// POST { kind: "seat"|"szv"|"nrv", seat?, applicationId, hours: 24|6 }: create an invite; the code goes to the
// applicant by email only. "szv" / "nrv" codes let the invitee pick any open seat of that type in their own area.
import { requireAdmin, rest, json } from "../../_lib/supa.js";
import { createInvite, dbMessage } from "../../_lib/invites.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  await rest(env, "rpc/invites_expire", { method: "POST", body: "{}" }).catch(() => null);
  const [invites, applications, history] = await Promise.all([
    rest(env, "verifier_offers?or=(seat_code.not.is.null,kind.neq.seat)&status=in.(sent,claimed)&select=id,kind,role,state_iso,region_id,seat_code,status,window_hours,expires_at,confirm_expires_at,created_by_public_id&order=expires_at.asc"),
    rest(env, "verifier_applications?status=eq.eligible&full_name=not.is.null&select=id,state_iso,role_sought,score,created_at&order=score.desc.nullslast,created_at.asc&limit=500"),
    rest(env, "seat_events?select=at,seat_code,event,public_id,pledge_version,actor_public_id,reason&order=id.desc&limit=50"),
  ]);
  const [opsSeats, opsHolders] = await Promise.all([
    rest(env, "ops_seats?select=code,label&order=ordinal.asc"),
    rest(env, "verifiers?ops_seat=not.is.null&select=ops_seat,public_id,active"),
  ]);
  const ops = opsSeats.map((s) => ({ ...s, holder: opsHolders.find((h) => h.ops_seat === s.code)?.public_id ?? null }));
  return json({ invites, applications, history, ops });
}

export async function onRequestPost({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const kind = b?.kind ?? "seat";
  if (!["seat", "szv", "nrv"].includes(kind) || (kind === "seat" && !/^(SZV-\d{3}|NRV-\d{2})$/.test(b?.seat ?? ""))
      || !/^[0-9a-f-]{36}$/.test(b?.applicationId ?? "") || ![24, 6].includes(b?.hours ?? 24)) {
    return json({ error: "kind (seat, szv or nrv), a seat for seat codes, applicationId and hours (24 or 6) are required. OpsAdmin seats are never offered by code." }, 422);
  }
  try {
    const r = await createInvite(env, { kind, seat: kind === "seat" ? b.seat : null, applicationId: b.applicationId, actorUserId: gate.user.id, hours: b.hours ?? 24 });
    const what = kind === "seat" ? r.seat : `any open ${kind.toUpperCase()} seat in ${r.area} (${r.openSeats} open)`;
    return json({ ok: true, ...r, note: r.emailed ? `Code for ${what} emailed to the applicant.` : "Invite created but the email failed: revoke it, then invite again." });
  } catch (e) {
    return json({ error: dbMessage(e) }, 409);
  }
}
