// POST /api/admin/meetings — BinchikAdmin (role key superadmin) sends a meeting invite to selected roles / regions / states (or all).
// Body: { title, when (ISO), link, channel: "signal"|"other", agenda: [], audience: { seats: ["SZV-073", "NRV-16"] }, dryRun }
// (legacy audience { roles, regions, states } still accepted). Signal is the default channel.
// Recipients are addressed by seat number only. dryRun returns the count and seats without sending.
import { TENANT } from "../../_lib/tenant.generated.js";   // time zone per country (session 98)
import { requireAdmin, rest, json } from "../../_lib/supa.js";
import { meetingInvite } from "../../_lib/emails.js";

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY) return json({ error: "not configured" }, 503);
  const gate = await requireAdmin(request, env);   // BinchikAdmin + MFA (aal2)
  if (gate instanceof Response) return gate;
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (!b?.title || !b?.when || !/^https:\/\//.test(b?.link ?? "")) return json({ error: "title, when and an https link are required" }, 422);
  const channel = b.channel === "other" ? "other" : "signal";   // Signal is the default channel
  if (channel === "signal" && !/^https:\/\/signal\.link\/call\//.test(b.link)) return json({ error: "a Signal call link starts with https://signal.link/call/" }, 422);
  const aud = b.audience ?? {};
  const all = await rest(env, "verifiers?active=is.true&select=user_id,role,public_id,seat_code,state_iso,region_id");
  let picked, label;
  if (Array.isArray(aud.seats)) {
    // Explicit seat list from the portal picker (one person is fine).
    const want = new Set(aud.seats.filter((c) => /^(SZV-\d{3}|NRV-\d{2})$/.test(c)));
    if (!want.size) return json({ error: "choose at least one seat" }, 422);
    picked = all.filter((v) => v.seat_code && want.has(v.seat_code));
    label = want.size <= 4 ? [...want].join(", ") : `${want.size} selected seats`;
  } else {
    const roles = aud.roles?.length ? aud.roles : ["szv", "nrv"];
    const regionStates = aud.regions?.length ? (await rest(env, `region_states?region_id=in.(${aud.regions.map(encodeURIComponent).join(",")})&select=state_iso`)).map((r) => r.state_iso) : [];
    picked = all.filter((v) => roles.includes(v.role) && (
      (!aud.regions?.length && !aud.states?.length) ||
      (v.role === "nrv" && aud.regions?.includes(v.region_id)) ||
      (v.role === "szv" && (aud.states?.includes(v.state_iso) || regionStates.includes(v.state_iso)))));
    label = aud.regions?.length || aud.states?.length ? [...(aud.regions ?? []), ...(aud.states ?? [])].join(", ") : "All verifiers";
  }
  const whenWAT = new Date(b.when).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + " WAT";
  if (b.dryRun) return json({ recipients: picked.length, selected: aud.seats?.length ?? null, seats: picked.map((v) => v.seat_code ?? v.public_id) });

  const msgs = [];
  for (const v of picked) {
    const u = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${v.user_id}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }).then((r) => r.json()).catch(() => null);
    if (!u?.email) continue;
    const mail = meetingInvite({ seat: v.seat_code ?? v.public_id, title: b.title, whenWAT, link: b.link, agenda: (b.agenda ?? []).slice(0, 12), audience: label, channel });
    msgs.push({ from: "Binchika <noreply@binchika.com>", to: [u.email], subject: mail.subject, html: mail.html });
  }
  let sent = 0;
  for (let i = 0; i < msgs.length; i += 100) {
    const r = await fetch("https://api.resend.com/emails/batch", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(msgs.slice(i, i + 100)) });
    if (r.ok) sent += Math.min(100, msgs.length - i);
  }
  return json({ ok: true, recipients: picked.length, sent });
}
