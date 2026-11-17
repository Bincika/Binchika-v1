// Session 134: review of verifier applications stored for a person to decide (status 'submitted': question 7 answered
// "not sure"). BinchikAdmin only, through /api/admin/applications (requireAdmin: locked address + aal2).
// Build plan: docs/egm/application-review/build-plan.md (main). No new store: decisions change the existing row;
// the request for information is an ordinary dashboard email (Sent), and replies arrive in the dashboard Inbox.
import { rest as supaRest } from "./supa.js";
import { sendEmail as resendEmail } from "./invites.js";
import { sendFromDashboard as dashSend } from "./mailsend.js";
import { applicationReviewed } from "./emails.js";
import { RULES } from "./screening.js";

// Never full_name, email, vin_hash, vin_last4, ip_hash or nin_hash: the decision does not need them.
export const REVIEW_SELECT = "id,state_iso,state_basis,role_sought,answers,score,created_at,consent_at,privacy_version";
export const REJECT_REASON = RULES.find(([q]) => q === "q7")[2];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const refOf = (id) => (typeof id === "string" && UUID.test(id) ? id.slice(0, 8).toLowerCase() : null);
export const INFO_SUBJECT = (ref) => `Your Binchika verifier application (ref ${ref}): one question`;
export const INFO_BODY = [
  "Thank you for applying to be a Binchika verifier.",
  "You answered \"not sure\" to question 7: whether you would flag a mismatch on a result sheet even if it hurt a party you support. Before we decide, please reply to this email in a few sentences: what would you do if the figures on a posted result sheet did not match what was uploaded, and the difference helped a party you like?",
  "There is no right length. We read every reply ourselves. Please do not send photos of result sheets, your voter card or any other documents. If you would rather withdraw, just say so.",
].join("\n\n");
const REQUEST_GAP_MS = 48 * 3600 * 1000;
const ACTIONS = new Set(["approve", "reject", "request_info"]);

const defaults = (deps = {}) => ({
  rest: deps.rest ?? supaRest,
  sendEmail: deps.sendEmail ?? resendEmail,
  sendFromDashboard: deps.sendFromDashboard ?? dashSend,
  meta: deps.meta ?? (async () => null),
  now: deps.now ?? (() => new Date()),
});
const log = (action, ref, by) => console.log(JSON.stringify({ event: "application_review", action, ref, by }));   // no personal data

/** Applications awaiting review, oldest first, with the latest request-for-information and reply times by ref. */
export async function listForReview(env, deps) {
  const d = defaults(deps);
  const rows = await d.rest(env, `verifier_applications?status=eq.submitted&select=${REVIEW_SELECT}&order=created_at.asc&limit=500`);
  const asked = new Map(), replied = new Map();
  if (env.DB) {
    const { results = [] } = await env.DB.prepare("SELECT direction, subject, at FROM mail_messages WHERE subject LIKE ?1 ORDER BY at DESC LIMIT 2000").bind("%(ref %").all();
    for (const m of results) {
      const ref = String(m.subject ?? "").match(/\(ref ([0-9a-f]{8})\)/)?.[1];
      if (!ref) continue;
      const map = m.direction === "out" ? asked : replied;
      if (!map.has(ref) || map.get(ref) < m.at) map.set(ref, m.at);
    }
  }
  const applications = (rows ?? []).map((a) => { const ref = refOf(a.id); return { ...a, ref, infoRequestedAt: asked.get(ref) ?? null, replyAt: replied.get(ref) ?? null }; });
  return { applications, mailKnown: Boolean(env.DB) };
}

const areaOf = (meta, role, iso) => (role === "nrv" ? meta?.verifierRegions?.regions?.find((g) => g.states.includes(iso))?.name : null) ?? meta?.states?.find((s) => s.iso === iso)?.name ?? iso;

/** approve | reject | request_info. @returns {{ status: number, body: object }} — never the applicant's address. */
export async function reviewAction(env, { action, applicationId, actor }, deps) {
  const d = defaults(deps);
  const ref = refOf(applicationId);
  if (!ACTIONS.has(action) || !ref) return { status: 422, body: { error: "action (approve, reject or request_info) and a valid applicationId are required." } };
  const gone = { status: 409, body: { error: `Application ref ${ref} is no longer awaiting review. Reload the list.` } };

  if (action === "request_info") {
    if (!env.DB || !env.RESEND_API_KEY) return { status: 503, body: { error: "Dashboard email is not configured, so the request cannot be sent or recorded." } };
    const [app] = await d.rest(env, `verifier_applications?id=eq.${applicationId}&status=eq.submitted&select=id,email`);
    if (!app) return gone;
    const last = await env.DB.prepare("SELECT at FROM mail_messages WHERE direction = 'out' AND subject LIKE ?1 ORDER BY at DESC LIMIT 1").bind(`%(ref ${ref})%`).first();
    if (last?.at && d.now().getTime() - new Date(last.at).getTime() < REQUEST_GAP_MS) return { status: 409, body: { error: `A request for ref ${ref} was already sent in the last 48 hours. The reply, if any, will arrive in the Inbox.` } };
    const r = await d.sendFromDashboard(env, { from: "ops", to: app.email, subject: INFO_SUBJECT(ref), body: INFO_BODY }, actor);
    if (r.status !== 200) return { status: r.status, body: { error: r.body?.error ?? "The request could not be sent." } };
    log(action, ref, actor);
    return { status: 200, body: { ok: true, action, ref, note: `Question sent to the applicant for ref ${ref} from ops@mail.example.org. Their reply will arrive in the Inbox with "ref ${ref}" in the subject.` } };
  }

  const change = action === "approve" ? { status: "eligible", score: 100 } : { status: "ineligible", ineligible_reasons: [REJECT_REASON] };
  const rows = await d.rest(env, `verifier_applications?id=eq.${applicationId}&status=eq.submitted&select=id,email,role_sought,state_iso`, { method: "PATCH", body: JSON.stringify(change) });
  const app = rows?.[0];
  if (!app) return gone;
  log(action, ref, actor);
  const meta = await d.meta().catch(() => null);
  const emailed = await d.sendEmail(env, app.email, applicationReviewed({ decision: action === "approve" ? "approved" : "rejected", role: app.role_sought, area: areaOf(meta, app.role_sought, app.state_iso), ref })).catch(() => false);
  const done = action === "approve" ? `Ref ${ref} approved: it is now in the eligible list.` : `Ref ${ref} rejected: it stays on file as ineligible until the retention date, so the same email or card cannot apply again.`;
  return { status: 200, body: { ok: true, action, ref, emailed, note: emailed ? `${done} The applicant was emailed.` : `${done} The email failed: please tell the applicant another way.` } };
}
