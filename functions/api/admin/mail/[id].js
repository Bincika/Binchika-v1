// GET /api/admin/mail/<id> — one message with its body (BinchikAdmin + MFA only). Opening an incoming message marks it read.
// POST /api/admin/mail/<id> { unread: true } marks it unread again. The HTML body is shown only in a sandboxed frame.
// DELETE /api/admin/mail/<id> removes it from the dashboard (D1 row + raw .eml in R2); the copy forwarded to the owner's
// inbox is not affected.
import { requireAdmin, json } from "../../../_lib/supa.js";
import { deleteMail } from "../../../_lib/mailsend.js";
import { isOptOutRequest } from "../../../_lib/campaigns.js";

const load = (env, id) => env.DB.prepare("SELECT * FROM mail_messages WHERE id = ?1").bind(id).first();

export async function onRequestGet({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "mailbox not configured" }, 503);
  const m = await load(env, String(params.id));
  if (!m) return json({ error: "not found" }, 404);
  if (m.direction === "in" && !m.read_at) await env.DB.prepare("UPDATE mail_messages SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(m.id).run();
  const { raw_key, ...rest } = m;
  // Session 96: an opt-out request shows its state and, if still open, a button that acts on it (/api/admin/optouts).
  const o = m.direction === "in" ? await env.DB.prepare("SELECT at, method, confirmed FROM opt_outs WHERE mail_id = ?1").bind(m.id).first().catch(() => null) : null;   // null before migration 0009
  const optout = o ? { state: "done", at: o.at, method: o.method, confirmed: Boolean(o.confirmed) } : m.direction === "in" && isOptOutRequest({ subject: m.subject, text: m.body_text }) ? { state: "open" } : null;
  return json({ message: { ...rest, optout, to_addrs: JSON.parse(m.to_addrs ?? "[]"), cc_addrs: JSON.parse(m.cc_addrs ?? "[]"), attachments: JSON.parse(m.attachments ?? "[]"), hasRaw: Boolean(raw_key) } });
}

export async function onRequestPost({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB) return json({ error: "mailbox not configured" }, 503);
  const b = await request.json().catch(() => ({}));
  if (b?.unread !== true) return json({ error: "nothing to change" }, 400);
  const r = await env.DB.prepare("UPDATE mail_messages SET read_at = NULL WHERE id = ?1 AND direction = 'in'").bind(String(params.id)).run();
  return r.meta?.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
}

export async function onRequestDelete({ request, env, params }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  const r = await deleteMail(env, String(params.id));
  return json(r.body, r.status);
}
