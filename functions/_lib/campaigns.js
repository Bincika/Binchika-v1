// Contacts, campaigns, BCC-only campaign send and unsubscribe (session 96; docs/egm/admin-contacts/build-plan.md).
// BinchikAdmin + MFA only (routes under /api/admin/contacts* and /api/admin/campaigns*), except the token-only
// /api/unsubscribe page and the mailbox Worker's reply keyword. Shared with tests. Guide: docs/EMAIL-GUIDE.md §5c.
// Privacy: the registry holds name, email and optional organisation and notes. A send log keeps counts, never addresses.
// Someone who unsubscribes is deleted and kept only as a hash and a masked address (opt_outs).
import { MAILBOXES, fromHeader, textToHtml } from "./mailbox.js";
import { general } from "./emails.js";

export const CAMPAIGN_MAX_RECIPIENTS = 50;   // per send
export const CAMPAIGN_DAILY_LIMIT = 50;      // campaign messages per 24 hours (Resend quota is shared with all other mail)
export const OPT_OUT_SENDER = "unsubscribe"; // sent_by of the confirmation emails recorded in Sent
export const OPT_OUT_DAILY_LIMIT = 30;       // confirmations per 24 hours; removal still happens above it
export const SITE = "https://binchika.com";
const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,255}\.[a-z]{2,}$/i;
const now = () => new Date().toISOString();
const clean = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const res = (status, body) => ({ status, body });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
}

/** @returns {{ ok: boolean, errors: string[], contact: { name, email, organisation, notes } }} */
export function validateContact(b) {
  const errors = [];
  const name = clean(b?.name, 200), email = String(b?.email ?? "").trim().toLowerCase();
  const organisation = clean(b?.organisation, 400) || null;
  const notes = String(b?.notes ?? "").replace(/\r\n/g, "\n").trim() || null;
  if (!name || name.length > 120) errors.push("name must be 1–120 characters");
  if (!EMAIL.test(email) || email.length > 254) errors.push("enter a valid email address");
  if (organisation && organisation.length > 160) errors.push("organisation must be at most 160 characters");
  if (notes && notes.length > 1000) errors.push("notes must be at most 1,000 characters");
  return { ok: errors.length === 0, errors, contact: { name, email, organisation, notes } };
}
export function validateCampaignName(s) {
  const name = clean(s, 200);
  return name && name.length <= 80 ? { ok: true, name } : { ok: false, error: "campaign name must be 1–80 characters" };
}

/** Keyed hash (HMAC-SHA256 with UNSUBSCRIBE_KEY) of the lower-case address, so opt_outs cannot be reversed by guessing
 * likely addresses. Rotating UNSUBSCRIBE_KEY would forget every opt-out: do not rotate it (docs/EMAIL-GUIDE.md §5c). */
export async function emailHash(key, email) {
  if (!key) throw new Error("UNSUBSCRIBE_KEY missing");
  return hex(await hmac(key, `optout:v1:${String(email ?? "").trim().toLowerCase()}`));
}
/** j***@example.org: enough for the BinchikAdmin to recognise a request, not the full address. */
export function maskEmail(email) {
  const [local, domain] = String(email ?? "").toLowerCase().split("@");
  return local && domain ? `${local[0]}***@${domain}` : "unknown";
}

// ---- Unsubscribe links: /api/unsubscribe?t=<contact id>.<signature>; HMAC-SHA256 with the UNSUBSCRIBE_KEY secret ----
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sign = async (key, contactId) => b64url(await hmac(key, `unsubscribe:v1:${contactId}`)).slice(0, 32);
const same = (a, b) => { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
export async function unsubToken(key, contactId) {
  if (!key) throw new Error("UNSUBSCRIBE_KEY missing");
  return `${contactId}.${await sign(key, contactId)}`;
}
/** @returns {Promise<string | null>} the contact id when the token is genuine, else null. Constant-time comparison. */
export async function readUnsubToken(key, token) {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(String(token ?? ""));
  if (!key || !m) return null;
  return same(await sign(key, m[1]), m[2]) ? m[1] : null;
}
export const unsubUrl = async (key, contactId) => `${SITE}/api/unsubscribe?t=${await unsubToken(key, contactId)}`;

/** Reply keyword: "unsubscribe", "stop" or "remove me" as the subject (after Re:) or the first line the person wrote. */
export function isOptOutRequest({ subject, text }) {
  const kw = /^\s*(unsubscribe|stop|remove me|opt out|opt-out)[\s.!]*$/i;
  const subj = String(subject ?? "").replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "");
  const first = String(text ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith(">")) ?? "";
  return kw.test(subj) || kw.test(first);
}

// ---- Registry ----
export async function listRegistry(env) {
  const [c, k, m, o, s] = await Promise.all([
    env.DB.prepare("SELECT id, name, email, organisation, notes, created_by, created_at, updated_at FROM contacts ORDER BY name COLLATE NOCASE").all(),
    env.DB.prepare("SELECT id, name, created_by, created_at FROM campaigns ORDER BY name COLLATE NOCASE").all(),
    env.DB.prepare("SELECT campaign_id, contact_id FROM campaign_members").all(),
    env.DB.prepare("SELECT id, email_masked, method, campaigns, mail_id, confirmed, at FROM opt_outs ORDER BY at DESC LIMIT 200").all(),
    env.DB.prepare("SELECT id, campaign_name, mailbox, subject, recipients, accepted, failed, owner_copy, status, sent_by, at FROM campaign_sends ORDER BY at DESC LIMIT 20").all(),
  ]);
  const members = m.results ?? [];
  return {
    contacts: (c.results ?? []).map((x) => ({ ...x, campaigns: members.filter((y) => y.contact_id === x.id).map((y) => y.campaign_id) })),
    campaigns: (k.results ?? []).map((x) => ({ ...x, members: members.filter((y) => y.campaign_id === x.id).length })),
    optOuts: (o.results ?? []).map((x) => ({ ...x, campaigns: JSON.parse(x.campaigns ?? "[]") })),
    sends: s.results ?? [],
  };
}

async function optedOut(env, email) {
  return env.DB.prepare("SELECT at FROM opt_outs WHERE email_sha256 = ?1").bind(await emailHash(env.UNSUBSCRIBE_KEY, email)).first();
}
const NO_KEY = res(503, { error: "Contacts are not configured (UNSUBSCRIBE_KEY missing)." });

export async function addContact(env, input, by) {
  if (!env.UNSUBSCRIBE_KEY) return NO_KEY;
  const v = validateContact(input);
  if (!v.ok) return res(422, { error: v.errors.join("; ") });
  const o = await optedOut(env, v.contact.email);
  if (o) return res(409, { error: `This address asked to be removed on ${o.at.slice(0, 10)} and cannot be added again.` });
  if (await env.DB.prepare("SELECT id FROM contacts WHERE email = ?1").bind(v.contact.email).first()) return res(409, { error: "A contact with this email address already exists." });
  const id = crypto.randomUUID(), c = v.contact;
  await env.DB.prepare("INSERT INTO contacts (id, name, email, organisation, notes, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, c.name, c.email, c.organisation, c.notes, by ?? null).run();
  return res(200, { ok: true, id });
}

export async function updateContact(env, id, input) {
  if (!env.UNSUBSCRIBE_KEY) return NO_KEY;
  const v = validateContact(input);
  if (!v.ok) return res(422, { error: v.errors.join("; ") });
  const c = v.contact;
  if (await optedOut(env, c.email)) return res(409, { error: "This address asked to be removed and cannot be used." });
  const clash = await env.DB.prepare("SELECT id FROM contacts WHERE email = ?1 AND id <> ?2").bind(c.email, String(id)).first();
  if (clash) return res(409, { error: "Another contact already has this email address." });
  const r = await env.DB.prepare("UPDATE contacts SET name = ?1, email = ?2, organisation = ?3, notes = ?4, updated_at = ?5 WHERE id = ?6").bind(c.name, c.email, c.organisation, c.notes, now(), String(id)).run();
  return r.meta?.changes ? res(200, { ok: true }) : res(404, { error: "not found" });
}

export async function removeContact(env, id) {
  const r = await env.DB.prepare("DELETE FROM contacts WHERE id = ?1").bind(String(id)).run();   // memberships cascade
  return r.meta?.changes ? res(200, { ok: true }) : res(404, { error: "not found" });
}

export async function createCampaign(env, name, by) {
  const v = validateCampaignName(name);
  if (!v.ok) return res(422, { error: v.error });
  if (await env.DB.prepare("SELECT id FROM campaigns WHERE name = ?1").bind(v.name).first()) return res(409, { error: "A campaign with this name already exists." });
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO campaigns (id, name, created_by) VALUES (?1, ?2, ?3)").bind(id, v.name, by ?? null).run();
  return res(200, { ok: true, id });
}

/** @param {{ name?: string, add?: string[], remove?: string[] }} b */
export async function updateCampaign(env, id, b) {
  const camp = await env.DB.prepare("SELECT id FROM campaigns WHERE id = ?1").bind(String(id)).first();
  if (!camp) return res(404, { error: "not found" });
  if (b?.name !== undefined) {
    const v = validateCampaignName(b.name);
    if (!v.ok) return res(422, { error: v.error });
    if (await env.DB.prepare("SELECT id FROM campaigns WHERE name = ?1 AND id <> ?2").bind(v.name, camp.id).first()) return res(409, { error: "A campaign with this name already exists." });
    await env.DB.prepare("UPDATE campaigns SET name = ?1 WHERE id = ?2").bind(v.name, camp.id).run();
  }
  const ids = (x) => (Array.isArray(x) ? x : []).map(String).filter((s) => /^[0-9a-f-]{36}$/.test(s)).slice(0, 500);
  let added = 0, removed = 0;
  for (const cid of ids(b?.add)) {
    const r = await env.DB.prepare("INSERT OR IGNORE INTO campaign_members (campaign_id, contact_id) SELECT ?1, id FROM contacts WHERE id = ?2").bind(camp.id, cid).run();
    added += r.meta?.changes ?? 0;
  }
  for (const cid of ids(b?.remove)) {
    const r = await env.DB.prepare("DELETE FROM campaign_members WHERE campaign_id = ?1 AND contact_id = ?2").bind(camp.id, cid).run();
    removed += r.meta?.changes ?? 0;
  }
  return res(200, { ok: true, added, removed });
}

export async function deleteCampaign(env, id) {
  const r = await env.DB.prepare("DELETE FROM campaigns WHERE id = ?1").bind(String(id)).run();   // members cascade; send log keeps the name
  return r.meta?.changes ? res(200, { ok: true }) : res(404, { error: "not found" });
}

// ---- Opt-out (link, reply keyword, or the BinchikAdmin acting on an Inbox request) ----
export function optOutConfirmation() {
  const subject = "You have been unsubscribed from Binchika emails";
  const body = "We have received your request to stop receiving emails from Binchika.\n\nBinchika will honour your request. Your name and email address have been removed from our contact registry and from every mailing list, and you will not receive further campaign emails from us.\n\nWe keep only a scrambled (hashed) form of your address so that it cannot be added again by mistake.\n\nIf this was a mistake, reply to this email and a person will help.";
  const signOff = "The Binchika team";
  const mail = general({ subject, bodyHtml: textToHtml(body), signOff, from: MAILBOXES.noreply.address, preheader: "Your request has been honoured." });
  return { subject, html: mail.html, text: `${body}\n\n${signOff}\nbinchika.com · ${MAILBOXES.noreply.address}` };
}

/**
 * Remove a person everywhere and record the opt-out. Idempotent: a second request changes nothing and sends nothing.
 * @param {{ contactId?: string, email?: string, method: "link"|"reply"|"admin", mailId?: string|null }} p
 * @returns {Promise<{ status: number, body: { ok?: boolean, removed?: boolean, already?: boolean, confirmed?: boolean, masked?: string, error?: string } }>}
 */
export async function optOut(env, { contactId, email, method, mailId = null }) {
  if (!env.DB || !env.UNSUBSCRIBE_KEY) return res(503, { error: "not configured" });
  if (!["link", "reply", "admin"].includes(method)) return res(400, { error: "bad method" });
  const contact = contactId
    ? await env.DB.prepare("SELECT id, email FROM contacts WHERE id = ?1").bind(String(contactId)).first()
    : await env.DB.prepare("SELECT id, email FROM contacts WHERE email = ?1").bind(String(email ?? "").trim().toLowerCase()).first();
  const addr = contact?.email ?? String(email ?? "").trim().toLowerCase();
  if (!EMAIL.test(addr)) return res(404, { error: "This address has already been removed, or the link is not valid." });
  const hash = await emailHash(env.UNSUBSCRIBE_KEY, addr);
  const prior = await env.DB.prepare("SELECT at FROM opt_outs WHERE email_sha256 = ?1").bind(hash).first();
  let names = [];
  if (contact) {
    names = ((await env.DB.prepare("SELECT k.name FROM campaign_members m JOIN campaigns k ON k.id = m.campaign_id WHERE m.contact_id = ?1").bind(contact.id).all()).results ?? []).map((r) => r.name);
    await env.DB.prepare("DELETE FROM contacts WHERE id = ?1").bind(contact.id).run();   // memberships cascade
  }
  if (prior) return res(200, { ok: true, removed: Boolean(contact), already: true, confirmed: false, masked: maskEmail(addr) });
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO opt_outs (id, email_sha256, email_masked, method, campaigns, mail_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, hash, maskEmail(addr), method, JSON.stringify(names), mailId).run();
  const confirmed = await sendOptOutConfirmation(env, addr);
  if (confirmed) await env.DB.prepare("UPDATE opt_outs SET confirmed = 1 WHERE id = ?1").bind(id).run();
  return res(200, { ok: true, removed: Boolean(contact), already: false, confirmed, masked: maskEmail(addr) });
}

/** The automated confirmation from noreply@, recorded in Sent. Never throws. */
async function sendOptOutConfirmation(env, addr) {
  try {
    if (!env.RESEND_API_KEY) return false;
    const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mail_messages WHERE direction = 'out' AND sent_by = ?1 AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").bind(OPT_OUT_SENDER).first();
    if ((recent?.n ?? 0) >= OPT_OUT_DAILY_LIMIT) return false;
    const m = optOutConfirmation();
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: fromHeader("noreply"), to: [addr], subject: m.subject, html: m.html, text: m.text, headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return false;
    await env.DB.prepare(`INSERT INTO mail_messages (id, direction, mailbox, from_addr, from_name, to_addrs, cc_addrs, subject, body_text, body_html, provider_id, sent_by, read_at, attachments)
      VALUES (?1, 'out', 'noreply', ?2, ?3, ?4, '[]', ?5, ?6, ?7, ?8, ?9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), '[]')`).bind(
      crypto.randomUUID(), MAILBOXES.noreply.address, MAILBOXES.noreply.name, JSON.stringify([addr]), m.subject, m.text, m.html, j.id ?? null, OPT_OUT_SENDER,
    ).run();
    return true;
  } catch { return false; }
}

// ---- Campaign send: one message per recipient, the recipient only in Bcc, plus one blind copy to the owner ----
const footerHtml = (url) => `You are receiving this because you are in Binchika's contact list. <a href="${esc(url)}" style="color:#983F14">Unsubscribe</a>, or reply with the word UNSUBSCRIBE.`;
const footerText = (url) => `You are receiving this because you are in Binchika's contact list.\nUnsubscribe: ${url}\nOr reply with the word UNSUBSCRIBE.`;

/**
 * @param {{ campaignId, from, subject, body, confirmCount?, dryRun? }} input
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function sendCampaign(env, input, sender) {
  if (!env.DB) return res(503, { error: "not configured" });
  if (!env.RESEND_API_KEY || !env.UNSUBSCRIBE_KEY || !EMAIL.test(String(env.CAMPAIGN_OWNER_BCC ?? ""))) return res(503, { error: "Campaign sending is not configured (email provider, unsubscribe key or owner copy address missing). Nothing was sent." });
  const camp = await env.DB.prepare("SELECT id, name FROM campaigns WHERE id = ?1").bind(String(input?.campaignId ?? "")).first();
  if (!camp) return res(404, { error: "Campaign not found." });
  const errors = [];
  const from = String(input?.from ?? "noreply");
  if (!MAILBOXES[from]) errors.push(`"From" must be one of: ${Object.values(MAILBOXES).map((m) => m.address).join(", ")}`);
  const subject = clean(input?.subject, 300), body = String(input?.body ?? "").replace(/\r\n/g, "\n").trim();
  if (!subject || subject.length > 200) errors.push("subject must be 1–200 characters");
  if (!body || body.length > 20000) errors.push("message must be 1–20,000 characters");
  const members = (await env.DB.prepare("SELECT c.id, c.email FROM campaign_members m JOIN contacts c ON c.id = m.contact_id WHERE m.campaign_id = ?1 ORDER BY c.email").bind(camp.id).all()).results ?? [];
  const blocked = new Set(((await env.DB.prepare("SELECT email_sha256 FROM opt_outs").all()).results ?? []).map((r) => r.email_sha256));
  const recipients = [];
  for (const m of members) if (!blocked.has(await emailHash(env.UNSUBSCRIBE_KEY, m.email))) recipients.push(m);
  if (!recipients.length) errors.push("this campaign has no contacts to send to");
  if (recipients.length > CAMPAIGN_MAX_RECIPIENTS) errors.push(`at most ${CAMPAIGN_MAX_RECIPIENTS} recipients per send; split the campaign`);
  if (errors.length) return res(422, { error: errors.join("; ") });
  const box = MAILBOXES[from];
  const template = (footer) => general({ subject, bodyHtml: textToHtml(body), signOff: box.name, from: box.address, footer }).html;
  const ownerNote = `Owner copy: this campaign ("${camp.name}") went to ${recipients.length} ${recipients.length === 1 ? "person" : "people"}, each individually by Bcc. Each person's copy has their own unsubscribe link.`;
  if (input?.dryRun) return res(200, { preview: template(footerHtml(`${SITE}/api/unsubscribe?t=preview`)), from: fromHeader(from), subject, recipients: recipients.length, campaign: camp.name, ownerCopy: true });
  if (Number(input?.confirmCount) !== recipients.length) return res(422, { error: `The campaign now has ${recipients.length} recipients. Preview again and confirm that number before sending.` });
  const today = await env.DB.prepare("SELECT COALESCE(SUM(accepted), 0) AS n FROM campaign_sends WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").first();
  if ((today?.n ?? 0) + recipients.length > CAMPAIGN_DAILY_LIMIT) return res(429, { error: `Daily limit of ${CAMPAIGN_DAILY_LIMIT} campaign emails: ${today?.n ?? 0} already sent in the last 24 hours. Nothing was sent.` });
  const id = crypto.randomUUID(), marker = await campaignMarker(env.UNSUBSCRIBE_KEY, id);
  await env.DB.prepare("INSERT INTO campaign_sends (id, campaign_id, campaign_name, mailbox, subject, body_text, recipients, sent_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(id, camp.id, camp.name, from, subject, body, recipients.length, sender ?? null).run();
  // "To" is our own From address (the mailbox Worker drops these loop-back copies by the X-Binchika-Campaign header);
  // the person is only in Bcc, so no one sees another recipient. Each message carries that person's own unsubscribe link.
  const messages = [];
  for (const r of recipients) {
    const url = await unsubUrl(env.UNSUBSCRIBE_KEY, r.id);
    messages.push({ from: fromHeader(from), to: [box.address], bcc: [r.email], subject, html: template(footerHtml(url)), text: `${body}\n\n${box.name}\nbinchika.com · ${box.address}\n\n${footerText(url)}`,
      headers: { "List-Unsubscribe": `<${url}>, <mailto:${box.address}?subject=unsubscribe>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Binchika-Campaign": marker } });
  }
  messages.push({ from: fromHeader(from), to: [box.address], bcc: [env.CAMPAIGN_OWNER_BCC], subject, html: template(esc(ownerNote)), text: `${body}\n\n${box.name}\nbinchika.com · ${box.address}\n\n${ownerNote}`, headers: { "X-Binchika-Campaign": marker } });
  let accepted = 0, ownerCopy = false, error = null;
  try {
    const r = await fetch("https://api.resend.com/emails/batch", {
      method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "Idempotency-Key": `campaign-${id}` },
      body: JSON.stringify(messages),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      const ids = Array.isArray(j?.data) ? j.data : [];
      accepted = ids.slice(0, recipients.length).filter((x) => x?.id).length;
      ownerCopy = Boolean(ids[recipients.length]?.id);
    } else error = `The email provider refused the send (${r.status}${j?.message ? `: ${String(j.message).slice(0, 160)}` : ""}).`;
  } catch (e) { error = `The email provider could not be reached (${String(e).slice(0, 80)}).`; }
  const status = accepted === recipients.length ? "sent" : accepted ? "partial" : "failed";
  await env.DB.prepare("UPDATE campaign_sends SET accepted = ?1, failed = ?2, owner_copy = ?3, status = ?4 WHERE id = ?5").bind(accepted, recipients.length - accepted, ownerCopy ? 1 : 0, status, id).run();
  if (status === "failed") return res(502, { error: `${error ?? "Nothing was accepted."} Nothing was sent.`, id });
  return res(200, { ok: true, id, campaign: camp.name, recipients: recipients.length, accepted, ownerCopy, status });
}

// Loop-back marker: <send id>.<HMAC signature>. Our own campaign copies come back to the From address; the mailbox
// Worker accepts them quietly before forwarding (no Inbox copy, no forward, no automatic reply). Only a message from
// @binchika.com with a genuine marker for a send of the last 3 days is skipped; anything else goes through as before.
const campaignMarker = async (key, id) => `${id}.${b64url(await hmac(key, `campaign:v1:${id}`)).slice(0, 32)}`;
/** Mailbox Worker: is this incoming message one of our own campaign copies coming back to the From address? `from` is the
 * From header (the envelope sender is Resend's bounce address). Never throws. */
export async function isCampaignLoopback(env, from, headers) {
  try {
    const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(String(headers?.get?.("x-binchika-campaign") ?? "").trim());
    if (!m || !env.UNSUBSCRIBE_KEY || !env.DB || !/@binchika\.com>?$/i.test(String(from ?? "").trim())) return false;
    if (!same(await campaignMarker(env.UNSUBSCRIBE_KEY, m[1]), m[0])) return false;
    return Boolean(await env.DB.prepare("SELECT id FROM campaign_sends WHERE id = ?1 AND at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days')").bind(m[1]).first());
  } catch { return false; }
}
