// /api/unsubscribe?t=<token> — the unsubscribe link in every campaign email (session 96). Public, but it acts only on the
// one contact named by a signed token (functions/_lib/campaigns.js; HMAC with the UNSUBSCRIBE_KEY secret). It collects
// nothing: no form fields, no address typed in.
// GET shows a confirmation page and changes nothing (mail scanners open links). POST unsubscribes: from that page's button,
// or from a mail client's one-click button (RFC 8058, body "List-Unsubscribe=One-Click"). The person is removed from
// contacts and every campaign, the opt-out is recorded, and noreply@ sends the confirmation once.
import { readUnsubToken, optOut, maskEmail } from "../_lib/campaigns.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const page = (status, title, inner) => new Response(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Binchika</title>
<style>:root{color-scheme:light dark}body{margin:0;font:17px/1.55 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#FAF7F0;color:#1A1C20}main{max-width:34rem;margin:0 auto;padding:3rem 1rem}h1{font-size:1.6rem;line-height:1.2;margin:0 0 1rem}a{color:#983F14}button{font:inherit;font-weight:700;min-height:44px;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#983F14;color:#fff;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #1A1C20;outline-offset:2px}.muted{color:#4A4E56;font-size:.95rem}@media (prefers-color-scheme:dark){body{background:#14161A;color:#ECE8DF}a{color:#F2A672}.muted{color:#B9B3A7}button:focus-visible,a:focus-visible{outline-color:#ECE8DF}}</style></head>
<body><main><p class="muted"><a href="/">Binchika</a></p><h1>${esc(title)}</h1>${inner}</main></body></html>`, {
  status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" },
});
const GONE = `<p>This address is no longer on our list, or the link is not complete. If you still receive emails from us, reply to one of them with the word UNSUBSCRIBE.</p>`;

async function contactFor(env, token) {
  const id = await readUnsubToken(env.UNSUBSCRIBE_KEY, token);
  return id ? { id, row: await env.DB.prepare("SELECT id, email FROM contacts WHERE id = ?1").bind(id).first() } : null;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB || !env.UNSUBSCRIBE_KEY) return page(503, "Unsubscribe is not available", `<p>Please try again later, or reply to our email with the word UNSUBSCRIBE.</p>`);
  const t = new URL(request.url).searchParams.get("t") ?? "";
  const c = await contactFor(env, t);
  if (!c) return page(400, "This link is not valid", GONE);
  if (!c.row) return page(200, "You are not on our list", GONE);
  return page(200, "Unsubscribe from Binchika emails", `<p>Stop all campaign emails from Binchika to <strong>${esc(maskEmail(c.row.email))}</strong>?</p>
<p>Your name and email address will be removed from our contact registry and from every mailing list. We will send one email to confirm.</p>
<form method="post" action="/api/unsubscribe?t=${esc(encodeURIComponent(t))}"><button type="submit">Unsubscribe</button></form>
<p class="muted">Changed your mind? Just close this page; nothing has changed.</p>`);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.UNSUBSCRIBE_KEY) return page(503, "Unsubscribe is not available", `<p>Please try again later, or reply to our email with the word UNSUBSCRIBE.</p>`);
  const c = await contactFor(env, new URL(request.url).searchParams.get("t") ?? "");
  if (!c) return page(400, "This link is not valid", GONE);
  if (!c.row) return page(200, "You are not on our list", GONE);
  const r = await optOut(env, { contactId: c.id, method: "link" });
  if (r.status !== 200) return page(r.status, "Something went wrong", `<p>Please reply to our email with the word UNSUBSCRIBE and we will remove you by hand.</p>`);
  return page(200, "You have been unsubscribed", `<p>Binchika will honour your request. ${esc(r.body.masked)} has been removed from our contact registry and from every mailing list.</p><p>${r.body.confirmed ? "We have sent one email to confirm." : "A confirmation email will follow if our daily sending limit allows; your removal has already taken effect."}</p>`);
}
