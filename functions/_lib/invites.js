// Seat invite codes, claim, typed-name pledge and seat release (design: docs/protocol/INVITE-FLOW.md).
// The state changes live in Supabase RPCs (migration 0007, service role only); this module does the
// hashing, Supabase Auth admin calls and emails around them. Codes and confirmation tokens are never
// stored or logged in plain form: only peppered SHA-256 hashes reach the database.
import { rest, isLockedAdminEmail } from "./supa.js";
import { inviteCode, seatConfirmation, welcomePacket, opsAppointed } from "./emails.js";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 symbols: no 0/O, 1/I/L or U
const enc = new TextEncoder();

/** 8 symbols ≈ 39 bits. Rejection sampling keeps every symbol equally likely. */
export function newCode() {
  let out = "";
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 240 && out.length < 8) out += ALPHABET[b % 30];
    }
  }
  return out;
}
export const normCode = (s) => String(s ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
export const formatCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
export const isCodeShape = (c) => new RegExp(`^[${ALPHABET}]{8}$`).test(c);

export async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hashCode = (code, pepper) => sha256hex(`code:${pepper}:${normCode(code)}`);
export const hashToken = (t, pepper) => sha256hex(`confirm:${pepper}:${t}`);
export const hashIp = (ip, pepper) => sha256hex(`ip:${pepper}:${ip ?? "unknown"}`);
export const newToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const COMMON = new Set(["password1234", "123456789012", "qwertyuiopas", "passwordpassword", "binchika1234", "nigeria12345", "iloveyou1234", "abcdefghijkl", "welcome12345", "letmein12345"]);
/** Returns a reason the password is unacceptable, or null. Supabase applies its own minimum too. */
export function passwordProblem(pw, email = "") {
  if (typeof pw !== "string" || pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 72) return "Use at most 72 characters.";
  if (/^(.)\1+$/.test(pw) || COMMON.has(pw.toLowerCase())) return "That password is too easy to guess.";
  const local = String(email).split("@")[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return "Don't use your email address in your password.";
  return null;
}
/** Mirror of public.norm_name (letters only, accents/case/spacing ignored). The database check is authoritative. */
export const normName = (s) => String(s ?? "").normalize("NFD").toLowerCase().replace(/[^a-z]/g, "");

const rpc = (env, fn, args) => rest(env, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const site = (env) => env.SITE_URL ?? "https://binchika.com";
const authAdmin = (env, path, init = {}) => fetch(`${env.SUPABASE_URL}/auth/v1/admin/${path}`, {
  ...init, headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
});

export async function sendEmail(env, to, mail) {
  if (!env.RESEND_API_KEY) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: "Binchika <noreply@binchika.com>", to: [to], subject: (env.EMAIL_SUBJECT_PREFIX ?? "") + mail.subject, html: mail.html }),
  });
  return r.ok;
}
const need = (env) => { if (!env.INVITE_PEPPER) throw new Error("INVITE_PEPPER is not set"); return env.INVITE_PEPPER; };

/**
 * Step 1 (BinchikAdmin): bind a code to an eligible application and email it. The code is never returned.
 * kind "seat" = one exact seat; "szv" / "nrv" = the invitee picks any open seat of that type in their own area.
 */
export async function createInvite(env, { kind = "seat", seat = null, applicationId, actorUserId, hours = 24, code = newCode() }) {
  // (code is injectable only for the e2e scripts; the HTTP route never passes one)
  const [row] = await rpc(env, "invite_create", { p_seat: kind === "seat" ? seat : null, p_application: applicationId, p_code_hash: await hashCode(code, need(env)), p_actor: actorUserId, p_hours: hours, p_kind: kind });
  const emailed = await sendEmail(env, row.email, inviteCode({ code: formatCode(code), seat: row.seat_code, area: row.area, hours, kind: row.kind, openSeats: row.open_seats, link: `${site(env)}/join/` }));
  return { kind: row.kind, seat: row.seat_code, area: row.area, openSeats: row.open_seats, expiresAt: row.expires_at, emailed };
}

/** BinchikAdmin: revoke an unclaimed code of any kind (a claimed seat is released instead). */
export async function revokeInvite(env, { offerId, actorUserId }) {
  const [r] = await rpc(env, "invite_revoke", { p_offer: offerId, p_actor: actorUserId });
  return { ok: true, seat: r?.seat_code ?? null, kind: r?.kind };
}

/** Step 2: does this code open a seat? Shows the seat (or the seats it may pick, open or taken) and the area only. */
export async function checkCode(env, { code, ip }) {
  const [r] = await rpc(env, "invite_check", { p_code_hash: await hashCode(code, need(env)), p_ip_hash: await hashIp(ip, need(env)) });
  return r;
}

/**
 * Step 3: email + password + state/region. Creates the Auth user (unconfirmed), binds the seat (inactive)
 * and emails the confirmation link. Returns the token to the caller for tests only; the HTTP route never does.
 */
export async function claimSeat(env, { code, email, password, area, ip, seat = null }) {
  const pepper = need(env);
  if (await isLockedAdminEmail(email)) return { error: "reserved_email" };
  const problem = passwordProblem(password, email);
  if (problem) return { error: "weak_password", message: problem };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? "").trim())) return { error: "bad_email" };
  const [chk] = await rpc(env, "invite_claim_check", { p_code_hash: await hashCode(code, pepper), p_email: email, p_area: area, p_ip_hash: await hashIp(ip, pepper), p_seat: seat });
  if (chk.result !== "ok") return { error: chk.result };
  const u = await authAdmin(env, "users", { method: "POST", body: JSON.stringify({ email: String(email).trim().toLowerCase(), password, email_confirm: false }) });
  const user = await u.json().catch(() => ({}));
  if (!u.ok) return { error: /already|exists|registered/i.test(user.msg ?? user.message ?? "") ? "account_exists" : "auth_error" };
  const token = newToken();
  try {
    const [fin] = await rpc(env, "invite_claim_finish", { p_offer: chk.offer_id, p_user: user.id, p_confirm_hash: await hashToken(token, pepper), p_seat: seat });
    const emailed = await sendEmail(env, String(email).trim(), seatConfirmation({ seat: fin.seat_code, publicId: fin.public_id, area: fin.area, link: `${site(env)}/join/pledge/#t=${token}` }));
    return { ok: true, seat: fin.seat_code, publicId: fin.public_id, area: fin.area, emailed, token };
  } catch (e) {
    await authAdmin(env, `users/${user.id}`, { method: "DELETE" });   // keep Auth and seats consistent
    return { error: /seat_unavailable|uq_offer_live_seat|duplicate key/.test(String(e?.message)) ? "seat_unavailable" : "claim_failed" };
  }
}

/** Step 5a: the pledge text for a confirmation token (or null if the link is used/expired). */
export async function pledgePreview(env, { token }) {
  const [p] = await rpc(env, "pledge_preview", { p_confirm_hash: await hashToken(token, need(env)) });
  return p ?? null;
}

/** Step 5b: typed-name pledge → seat active, email confirmed, welcome packet sent. */
export async function signPledge(env, { token, typedName, version, accept }) {
  if (accept !== true) return { error: "not_accepted" };
  const [r] = await rpc(env, "pledge_sign", { p_confirm_hash: await hashToken(token, need(env)), p_typed_name: String(typedName ?? "").slice(0, 120), p_version: version });
  if (r.result !== "ok") return { error: r.result };
  await authAdmin(env, `users/${r.user_id}`, { method: "PUT", body: JSON.stringify({ email_confirm: true }) });
  const emailed = await sendEmail(env, r.email, welcomePacket({ seat: r.seat_code, publicId: r.public_id, role: r.role, area: r.area }));
  return { ok: true, seat: r.seat_code, publicId: r.public_id, emailed };
}

/** Step 6 (BinchikAdmin): release a seat (SZV, NRV or OPS). The holder is deactivated and their account banned; the public ID is retired. */
export async function releaseSeat(env, { seat, reason, actorUserId }) {
  const [r] = await rpc(env, "seat_release", { p_seat: seat, p_reason: reason, p_actor: actorUserId });
  let banned = false;
  if (r?.released_user) banned = (await authAdmin(env, `users/${r.released_user}`, { method: "PUT", body: JSON.stringify({ ban_duration: "876000h" }) })).ok;
  return { ok: true, seat, publicId: r?.public_id ?? null, banned };
}

/**
 * BinchikAdmin appoints an OpsAdmin to one of the three OPS seats. Never by invite code or application: the address
 * must never have had a Binchika account. The account is created confirmed, without a password; the appointee gets
 * a sign-in link, must enrol an authenticator (MFA) before any admin power works, and can then set a password.
 */
export async function appointOps(env, { seat, email, actorUserId }) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!/^OPS-[1-3]$/.test(seat ?? "")) return { error: "There are only three OpsAdmin seats: OPS-1, OPS-2 and OPS-3." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { error: "Enter a valid email address." };
  if (await isLockedAdminEmail(e)) return { error: "The BinchikAdmin cannot also be an OpsAdmin." };
  const u = await authAdmin(env, "users", { method: "POST", body: JSON.stringify({ email: e, email_confirm: true }) });
  const user = await u.json().catch(() => ({}));
  if (!u.ok) return { error: /already|exists|registered/i.test(user.msg ?? user.message ?? "") ? "That address already has (or had) a Binchika account. Use an address that has never been used here." : "Could not create the account." };
  let row;
  try { [row] = await rpc(env, "ops_assign", { p_seat: seat, p_user: user.id, p_actor: actorUserId }); }
  catch (err) { await authAdmin(env, `users/${user.id}`, { method: "DELETE" }); return { error: dbMessage(err) }; }
  const j = await (await authAdmin(env, "generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email: e }) })).json().catch(() => ({}));
  const hashed = j.hashed_token ?? j.properties?.hashed_token;
  const emailed = hashed ? await sendEmail(env, e, opsAppointed({ seat, publicId: row.public_id, link: `${site(env)}/portal/#th=${encodeURIComponent(hashed)}` })) : false;
  return { ok: true, seat, publicId: row.public_id, userId: user.id, emailed };
}

/** Postgres error text from rest() → a short message safe to show the BinchikAdmin. */
export const dbMessage = (e) => (String(e?.message ?? e).match(/"message":"([^"]+)"/)?.[1] ?? "database error");
