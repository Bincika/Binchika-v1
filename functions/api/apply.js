// /api/apply — verifier application intake. CLOSED unless both APPLICATIONS_OPEN=true and PRIVACY_NOTICE_VERSION
// are set (constitution §5: no personal data before a reviewed, published privacy notice).
// GET  → { open, privacyVersion, privacyUrl }
// POST { fullName, email, state, basis, role, vin, answers, consent, privacyVersion }
// Screens with the published rules; ineligible answers are explained and NOT stored. Stored: full name, email,
// state, role, answers, voter-card number as a salted hash + last 4 only. Never BVN, NIN or biometrics.
import { supaConfigured, rest, json } from "../_lib/supa.js";
import { screen, cleanAnswers } from "../_lib/screening.js";
import { sha256hex, sendEmail } from "../_lib/invites.js";
import { applicationReceived } from "../_lib/emails.js";

const isOpen = (env) => env.APPLICATIONS_OPEN === "true" && Boolean(env.PRIVACY_NOTICE_VERSION) && supaConfigured(env) && Boolean(env.INVITE_PEPPER);
const status = (env) => ({ open: isOpen(env), privacyVersion: env.PRIVACY_NOTICE_VERSION ?? null, privacyUrl: env.PRIVACY_NOTICE_URL ?? "/privacy/" });
const MSG = {
  duplicate_email: "There is already an application for this email address. To change it, use the contact page.",
  duplicate_card: "There is already an application for this voter card.",
  rate_limited: "Too many applications from this connection today. Please try again tomorrow.",
};

export const onRequestGet = ({ env }) => json(status(env));

export async function onRequestPost({ request, env }) {
  if (!isOpen(env)) return json({ error: "Applications are not open yet. They open once our privacy notice is published.", ...status(env) }, 403);
  let b;
  try { b = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const fullName = String(b?.fullName ?? "").trim().replace(/\s+/g, " ");
  const email = String(b?.email ?? "").trim().toLowerCase();
  const vin = String(b?.vin ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const meta = await (await fetch(new URL("/data/states.json", request.url))).json();
  const st = meta.states.find((s) => s.iso === b?.state);
  const errors = [];
  if (fullName.length < 3 || fullName.length > 120 || fullName.split(" ").length < 2) errors.push("Please give your full name (first and last name), as you will type it when signing the pledge.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.push("Please give a valid email address.");
  if (!st) errors.push("Please choose your state.");
  if (!["origin", "residence"].includes(b?.basis)) errors.push("Please say whether this is your state of origin or residence.");
  if (!["szv", "nrv"].includes(b?.role)) errors.push("Please choose the role you are applying for.");
  if (vin.length < 16 || vin.length > 22) errors.push("Please enter the voter identification number (VIN) printed on your voter card.");
  if (b?.consent !== true || b?.privacyVersion !== env.PRIVACY_NOTICE_VERSION) errors.push("Please read and accept the current privacy notice.");
  if (errors.length) return json({ error: errors.join(" "), errors }, 422);

  const answers = cleanAnswers(b.answers);
  const verdict = screen(answers);
  if (verdict.status === "incomplete") return json({ error: `Please answer question${verdict.missing.length > 1 ? "s" : ""} ${verdict.missing.map((q) => q.slice(1)).join(", ")}.` }, 422);
  if (verdict.status === "ineligible") return json({ ok: false, stored: false, eligible: false, reasons: verdict.reasons }); // not stored

  const pepper = env.INVITE_PEPPER;
  const [r] = await rest(env, "rpc/application_submit", { method: "POST", body: JSON.stringify({
    p_full_name: fullName, p_email: email, p_state: st.iso, p_basis: b.basis, p_role: b.role, p_answers: answers,
    p_status: verdict.status, p_score: verdict.score, p_vin_hash: await sha256hex(`vin:${pepper}:${vin}`), p_vin_last4: vin.slice(-4),
    p_privacy: env.PRIVACY_NOTICE_VERSION, p_ip_hash: await sha256hex(`ip:${pepper}:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`),
  }) });
  if (r.result !== "ok") return json({ error: MSG[r.result] ?? "Could not save your application. Please try again." }, r.result === "rate_limited" ? 429 : 409);
  const area = b.role === "nrv" ? meta.verifierRegions.regions.find((g) => g.states.includes(st.iso))?.name ?? st.name : st.name;
  const emailed = await sendEmail(env, email, applicationReceived({ role: b.role, area, review: verdict.status === "submitted" }));
  return json({ ok: true, stored: true, eligible: verdict.status === "eligible", review: verdict.status === "submitted", emailed });
}
