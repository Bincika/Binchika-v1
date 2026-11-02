// Media access requests (session 91; docs/reports/MEDIA-INTEGRATION-REPORT.md). A newsroom, agency, observer group or
// research team asks through the contact form (topic "media_access") to be registered for the press feed. No new data
// store: the request's details go into the enquiry text, which lives only in the existing mailbox (mail_messages, R2
// raw copy, BinchikAdmin only, 365-day retention). The ticket keeps only its topic and a decision note without names,
// and is deleted with the message, so an approval lapses after 12 months. Pure; shared by the API, the portal and tests.

import { TENANT } from "./tenant.generated.js";   // notice wording per country (session 98)
export const MEDIA_NATURE = "media_access";
export const MEDIA_TYPES = {
  broadcaster: "Broadcaster (TV or radio)",
  newsroom: "Newspaper or online newsroom",
  agency: "News agency or wire service",
  observer: "Election observer or civic organisation",
  research: "University or research group",
  other: "Other media organisation",
};
export const MEDIA_USES = {
  live_page: "Live results page or embed",
  broadcast: "On-air graphics",
  analysis: "Analysis or research",
  factcheck: "Fact-checking or verification",
};
export const MEDIA_POLLING = {
  "15s": "Every 15 seconds (the fastest the feed changes)",
  minute: "About once a minute",
  hour: "About once an hour",
  day: "Daily or less often",
};
export const MEDIA_TERMS = `Show “${TENANT.notice}” beside the figures, credit Binchika, and never present the figures as official results, a projection or a winner.`;
export const FEED_URL = "https://binchika.com/api/press/snapshot?race=president";
// Free mail providers: the address cannot show that the sender works for the organisation.
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|proton|protonmail|gmx|mail|zoho|yandex)\.[a-z.]+$/i;

const REG_NO = /^[A-Za-z0-9][A-Za-z0-9 .\/-]{1,39}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;
const clean = (s, n) => String(s ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n);
const hostOf = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.hostname.toLowerCase().replace(/^www\./, "") : null; } catch { return null; } };

/** Does the email's domain belong to the organisation's website? "free" for a free mail provider. */
export function domainMatch(email, orgUrl) {
  const d = String(email ?? "").split("@")[1]?.toLowerCase().trim() ?? "";
  const h = hostOf(orgUrl);
  if (!d || !h) return "no";
  if (FREE_MAIL.test(d)) return "free";
  return d === h || d.endsWith(`.${h}`) || h.endsWith(`.${d}`) ? "yes" : "no";
}

/**
 * Validates the extra fields of a media access request (the general contact checks run first).
 * @param {{ org, orgUrl, orgType, use, polling, terms }} f
 */
export function validateMedia(f) {
  const errors = [];
  const org = clean(f?.org, 121);
  if (org.length < 2 || org.length > 120) errors.push("organisation name must be 2–120 characters");
  const orgUrl = String(f?.orgUrl ?? "").trim();
  const host = orgUrl.length <= 200 ? hostOf(orgUrl) : null;
  if (!host || !host.includes(".")) errors.push("organisation website must be its https address");
  if (!MEDIA_TYPES[f?.orgType]) errors.push("choose the type of organisation");
  if (!MEDIA_USES[f?.use]) errors.push("choose how you will use the feed");
  if (!MEDIA_POLLING[f?.polling]) errors.push("choose how often you will check the feed");
  if (f?.terms !== "yes") errors.push("the terms of use must be accepted");
  // Session 92 (/media/): a registration number and a technical contact, both optional. The reviewer checks the
  // registry by hand, and asks for the number with "Ask for more" when it matters.
  const regNo = clean(f?.regNo, 41);
  if (regNo && !REG_NO.test(regNo)) errors.push("registration number: 2–40 letters, digits, spaces, dots, slashes or hyphens");
  const techEmail = clean(f?.techEmail, 321).toLowerCase();
  if (techEmail && !EMAIL.test(techEmail)) errors.push("technical contact must be a valid email address");
  return errors.length ? { ok: false, errors } : { ok: true, value: { org, orgUrl, orgType: f.orgType, use: f.use, polling: f.polling, regNo, techEmail } };
}

const YN = { yes: "yes", no: "no", free: "no (free mail address)" };

/**
 * The request block placed above the requester's message in the owner copy and the Inbox copy. `auto` holds the DNS
 * checks (mediaAutoChecks); without it those lines are left out.
 */
export function mediaBlock(v, email, auto = null) {
  return [
    "Media access request",
    `Organisation: ${v.org}`,
    `Registration number: ${v.regNo || "(not given)"}`,
    `Website: ${v.orgUrl}`,
    `Technical contact: ${v.techEmail || "(not given)"}`,
    `Type: ${MEDIA_TYPES[v.orgType]}`,
    `Intended use: ${MEDIA_USES[v.use]}`,
    `Checking the feed: ${MEDIA_POLLING[v.polling]}`,
    "Terms accepted: yes",
    `Email domain matches the website: ${YN[domainMatch(email, v.orgUrl)]}`,
    `Technical contact on the organisation's domain: ${v.techEmail ? YN[domainMatch(v.techEmail, v.orgUrl)] : "not given"}`,
    ...(auto ? [`Website domain resolves: ${auto.resolves ? "yes" : "no"}`, `Email domain receives mail (MX): ${auto.mx ? "yes" : "no"}`] : []),
  ];
}

/**
 * Two DNS checks through Cloudflare's DNS-over-HTTPS resolver (session 92). They ask only a fixed public resolver about
 * the website's domain and the email's domain: nothing is fetched from an address the requester typed, so the form cannot
 * be used to make Binchika call arbitrary hosts. Each lookup times out after 2.5 s and counts as "no"; a check never
 * blocks a request.
 * @returns {Promise<{ resolves: boolean, mx: boolean }>}
 */
export async function mediaAutoChecks(v, email, fetchImpl = fetch) {
  const ask = async (name, type) => {
    if (!name || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(name)) return false;
    try {
      const r = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(2500) });
      if (!r.ok) return false;
      const j = await r.json();
      const code = { A: 1, AAAA: 28, MX: 15 }[type];
      return j?.Status === 0 && Array.isArray(j.Answer) && j.Answer.some((a) => a?.type === code);
    } catch { return false; }
  };
  const host = hostOf(v?.orgUrl);
  const domain = String(email ?? "").split("@")[1]?.toLowerCase().trim();
  const [a, aaaa, mx] = await Promise.all([ask(host, "A"), ask(host, "AAAA"), ask(domain, "MX")]);
  return { resolves: a || aaaa, mx };
}

/**
 * The review checklist, read back from the stored enquiry text on the server. Returns booleans and fixed labels only,
 * never the organisation's name, website or the sender's address.
 */
export function mediaChecks(text) {
  // Session 92 (Goldfish review): read only the block the server wrote, from "Media access request" to the first blank
  // line. Lines elsewhere (the sender's name, their message) can never count as a check, even if someone types them.
  const all = String(text ?? "").replace(/\r\n/g, "\n");
  const start = all.search(/^Media access request$/m);
  const t = start < 0 ? "" : all.slice(start).split(/\n\s*\n/)[0];
  const line = (k) => (t.match(new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.*)$`, "m")) ?? [])[1]?.trim() ?? "";
  const type = Object.entries(MEDIA_TYPES).find(([, l]) => l === line("Type"))?.[0] ?? null;
  const use = Object.entries(MEDIA_USES).find(([, l]) => l === line("Intended use"))?.[0] ?? null;
  const polling = Object.entries(MEDIA_POLLING).find(([, l]) => l === line("Checking the feed"))?.[0] ?? null;
  const checks = {
    request: /^Media access request$/m.test(t),
    website: Boolean(hostOf(line("Website"))),
    domain: line("Email domain matches the website") === "yes",
    terms: line("Terms accepted") === "yes",
    type: Boolean(type),
    use: Boolean(use),
    // Session 92 checks (requests sent before 1 November 2026, session 92, do not have these lines and show them as missing).
    registration: Boolean(line("Registration number")) && line("Registration number") !== "(not given)",
    resolves: line("Website domain resolves") === "yes",
    mx: line("Email domain receives mail (MX)") === "yes",
  };
  return { checks, passed: Object.values(checks).filter(Boolean).length, of: Object.keys(checks).length, type, use, polling };
}

// Neutral decline reasons (session 92). The reviewer picks one; the decline reply uses its sentence.
export const MEDIA_DECLINE_REASONS = {
  unconfirmed: { label: "Organisation not confirmed", text: "we could not confirm the organisation, or that the request comes from it" },
  not_media: { label: "Not a media, observer or research organisation", text: "the request does not come from a media, election-observer or research organisation (political parties and campaigns use our party channel instead)" },
  use: { label: "Use would present figures as results", text: "the intended use, as described, would present the figures as official results or as a projection" },
  no_reply: { label: "No reply to our request for more", text: "we did not receive the further information we asked for" },
};

export const MEDIA_DECISIONS = {
  approved: { label: "Approve", status: "answered", note: "Media access: approved" },
  more_info: { label: "Ask for more", status: "in_progress", note: "Media access: more information requested" },
  declined: { label: "Decline", status: "answered", note: "Media access: declined" },
};
const PREFIX = "media-access:";

/** The ticket resolution for a decision: a fixed prefix the register can find, plus the reviewer's short note. */
export function mediaResolution(decision, note = "") {
  if (!MEDIA_DECISIONS[decision]) return null;
  const n = clean(note, 400);
  return `${PREFIX}${decision} · ${MEDIA_DECISIONS[decision].note}${n ? `. ${n}` : ""}`.slice(0, 500);
}
/** The decision recorded on a ticket, or null. */
export function mediaDecisionOf(resolution) {
  const m = String(resolution ?? "").match(/^media-access:(approved|more_info|declined)\b/);
  return m ? m[1] : null;
}

/** The paragraph added to the automatic reply for a media access request. */
export function mediaAutoReplyText() {
  return `Your media access request is logged for review. We aim to reply within two working days.\n\nYou do not need to wait to start: the public press feed is open to everyone without a key at ${FEED_URL} (other races: senate, house, governor, state-assembly). It carries citizen-verified tallies only. Wherever you show the figures, please show "Citizen-verified tallies. Only INEC declares results." beside them.`;
}

/** Draft replies for the reviewer to read, edit and send from the dashboard. Nothing is sent automatically. */
export function mediaReply(decision, ref, reason = "unconfirmed") {
  const r = /^BIN-\d{4}-\d{4,}$/.test(String(ref ?? "")) ? String(ref) : null;
  const refLine = r ? `Your reference is ${r}. Please keep it in the subject line when you write to us.` : "Please reply to this email if you have questions.";
  const end = "\n\nThe Binchika team";
  if (decision === "approved") return `Hello,

Thank you for your request. Your organisation is now registered for the Binchika press feed.

How to connect
- Address: ${FEED_URL}. The other races are senate, house, governor and state-assembly.
- The feed is JSON and changes at most every 15 seconds; checking more often returns the same copy. No key is needed.
- To check the figures yourself, read https://binchika.com/api/ledger and verify the hash chain with our open-source code (https://github.com/Bincika/Binchika-v1).

The terms you accepted
- Show "${TENANT.notice}" beside the figures.
- Credit Binchika (binchika.com).
- Never present the figures as official results, a projection or a winner.

What registration gives you: a named route for corrections and questions during the count (reply to this email), and notice before the feed's format changes. It does not give access to anything beyond the public feed: no photographs, no personal data and no reports before they pass our checks.

Registration lasts 12 months from your request; after that, please apply again through binchika.com/media/.

${refLine}${end}`;
  if (decision === "more_info") return `Hello,

Thank you for your request. Before we can register your organisation for the press feed, we need a little more:

- an email address at your organisation's own domain, or a link to a public page that names you as part of the team; and
- the address of the page or programme where the figures will appear.

Reply to this email with those details. In the meantime the public feed stays open to everyone at ${FEED_URL}, under the same notice: "${TENANT.notice}"

${refLine}${end}`;
  if (decision === "declined") return `Hello,

Thank you for your request. We are not able to register your organisation for the press feed at this time, because ${(MEDIA_DECLINE_REASONS[reason] ?? MEDIA_DECLINE_REASONS.unconfirmed).text}. We apply the same criteria to every applicant.

The public feed itself stays open to everyone at ${FEED_URL}, under the same notice: "${TENANT.notice}" If your circumstances change, you are welcome to apply again through binchika.com/media/.

${refLine}${end}`;
  return null;
}

/**
 * Record a reviewer's decision on a media access ticket (BinchikAdmin, through the tickets API).
 * Refuses tickets of any other topic, so the media register cannot be written from elsewhere.
 * @returns {Promise<{ status: number, body: object }>}
 */
export async function decideMedia(db, ref, { decision, note } = {}, actorPublicId, updateTicket, now = new Date()) {
  if (!MEDIA_DECISIONS[decision]) return { status: 422, body: { error: `decision must be one of ${Object.keys(MEDIA_DECISIONS).join(", ")}` } };
  if (note !== undefined && (typeof note !== "string" || note.length > 400)) return { status: 422, body: { error: "note must be text of at most 400 characters" } };
  const cur = await db.prepare("SELECT nature FROM tickets WHERE ref = ?1").bind(String(ref ?? "")).first();
  if (!cur) return { status: 404, body: { error: "not found" } };
  if (cur.nature !== MEDIA_NATURE) return { status: 409, body: { error: "only media access requests take a media decision" } };
  return updateTicket(db, ref, { status: MEDIA_DECISIONS[decision].status, resolution: mediaResolution(decision, note) }, actorPublicId, now);
}
