// GET /api/admin/mail/attachment?id=<message id>&n=<index> — BinchikAdmin + MFA only. Re-reads the raw message kept in
// R2 (mail/raw/<id>.eml) and returns one attachment as a download (never rendered inline).
import PostalMime from "postal-mime";
import { requireAdmin, json } from "../../../_lib/supa.js";

export async function onRequestGet({ request, env }) {
  const gate = await requireAdmin(request, env);
  if (gate instanceof Response) return gate;
  if (!env.DB || !env.EVIDENCE) return json({ error: "mailbox not configured" }, 503);
  const u = new URL(request.url);
  const n = Number(u.searchParams.get("n"));
  const m = await env.DB.prepare("SELECT raw_key FROM mail_messages WHERE id = ?1 AND direction = 'in'").bind(String(u.searchParams.get("id"))).first();
  if (!m?.raw_key || !Number.isInteger(n) || n < 0) return json({ error: "not found" }, 404);
  const obj = await env.EVIDENCE.get(m.raw_key);
  if (!obj) return json({ error: "raw message not found" }, 404);
  const a = (await PostalMime.parse(await obj.arrayBuffer())).attachments?.[n];
  if (!a) return json({ error: "not found" }, 404);
  const name = String(a.filename ?? `attachment-${n}`).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `attachment-${n}`;
  return new Response(a.content, { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" } });
}
