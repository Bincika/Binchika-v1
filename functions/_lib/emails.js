// Binchika transactional email templates (table layout + inline styles for Gmail/Outlook; dark-mode friendly).
// Verifiers are always addressed by their seat number / public ID, never by name.
// Used by Pages Functions (meeting invites) and scripts/send-email-samples.mjs. Pure string builders.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const BRAND = "https://binchika.com/assets/img/brand/dash-128.png";
const ACCENT = "#F2600C";

const AGOGO = "https://binchika.com/assets/img/brand/agogo-128.png";   // official agogo logo, unchanged (from Media/banchika_v1.png)
const APPLIED = "You received this because you applied to volunteer with Binchika.";

function shell({ preheader, title, body, footerNote, logo = BRAND, reason = APPLIED }) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(title)}</title>
<style>@media (prefers-color-scheme: dark){.bg{background:#0A0B0D!important}.card{background:#15171B!important;border-color:#2A2D33!important;color:#F4F2EE!important}.card a{color:#F5A66E!important}.ink{color:#F4F2EE!important}.muted{color:#A8AEB6!important}.tile{background:#1F2228!important;color:#F4F2EE!important;border-color:#33373E!important}}</style></head>
<body style="margin:0;padding:0;background:#F6F5F1" class="bg">
<span style="display:none!important;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:#F6F5F1"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td><img src="${logo}" width="40" height="40" alt="" style="display:block;border:0"></td>
<td style="padding-left:10px;font:900 20px/1 Arial,Helvetica,sans-serif;letter-spacing:-.5px" class="ink"><span style="color:#0D0E10" class="ink">Bin</span><span style="color:${ACCENT}">chika</span></td></tr></table></td></tr>
<tr><td class="card" style="background:#FFFFFF;border:1px solid #E6E2D8;border-radius:16px;padding:28px 26px;font:16px/1.55 Arial,Helvetica,sans-serif;color:#0D0E10">${body}</td></tr>
<tr><td style="padding:16px 6px;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6B6F76" class="muted">${footerNote ?? ""}Binchika is a citizen transparency layer. Only INEC declares election results.<br>${reason} <a href="https://binchika.com/contact/" style="color:#6B6F76">Contact us</a></td></tr>
</table></td></tr></table></body></html>`;
}

const digits = (code) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px"><tr>${String(code).split("").map((d) => `<td class="tile" style="background:#F3F1EC;border:1px solid #E1DCD1;border-radius:8px;width:40px;height:50px;text-align:center;font:700 26px/50px 'Courier New',monospace;color:#0D0E10">${esc(d)}</td><td style="width:6px"></td>`).join("")}</tr></table>`;
const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px"><tr><td style="background:${ACCENT};border-radius:999px"><a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 16px Arial,Helvetica,sans-serif;color:#FFFFFF;text-decoration:none">${esc(label)}</a></td></tr></table>`;

/** Account confirmation / one-time code. Subject puts the code first so Gmail offers "Copy code". */
export function verificationCode({ code, seat, minutes = 15 }) {
  return {
    subject: `${code} is your Binchika verification code`,
    html: shell({
      preheader: `Your code is ${code}. It expires in ${minutes} minutes.`,
      title: "Your Binchika verification code",
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">Code requested${seat ? ` · ${esc(seat)}` : ""}</p>
        ${digits(code)}
        <p style="margin:8px 0 0;font:600 15px 'Courier New',monospace" class="ink">Copy: <span style="user-select:all;-webkit-user-select:all;background:#FFF2E6;padding:2px 6px;border-radius:6px">${esc(code)}</span></p>
        <p style="margin:16px 0 0">Enter this code on binchika.com to confirm your verifier account. It expires in ${minutes} minutes and works once.</p>
        <p style="margin:12px 0 0;color:#5B5F67" class="muted">If you didn't ask for this, ignore this email. Your account stays safe. Binchika will never ask for your password, BVN or bank details.</p>`,
    }),
  };
}

/**
 * Seat invite code (step 1 of the invite flow). Subject puts the code first so Gmail offers "Copy code".
 * kind "seat" offers one exact seat; "szv" / "nrv" lets the invitee pick any open seat of that type in their area.
 */
export function inviteCode({ code, seat, area, hours, link, kind = "seat", openSeats }) {
  const pick = kind !== "seat";
  const type = kind === "nrv" ? "NRV" : "SZV";
  const offer = pick ? `${type} seat · ${area}` : `${seat} · ${area}`;
  return {
    subject: `${code} is your Binchika seat code`,
    html: shell({
      preheader: `${pick ? `Choose an open ${type} seat` : `Seat ${seat}`} · ${area}. Use the code within ${hours} hours.`,
      title: "Your Binchika seat code",
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">Seat offered · ${esc(offer)}</p>
        <h1 style="margin:0 0 10px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">You have been selected.</h1>
        <p style="margin:0">${pick
          ? `Your application was screened and you may choose any open <strong>${type}</strong> seat for <strong>${esc(area)}</strong>${openSeats ? ` (${esc(openSeats)} open when this code was made)` : ""}. You pick the seat after entering the code; seats already taken are greyed out. Your code:`
          : `Your application was screened and you are offered seat <strong>${esc(seat)}</strong> for <strong>${esc(area)}</strong>. Your code:`}</p>
        ${digits(code.replace("-", ""))}
        <p style="margin:8px 0 0;font:600 15px 'Courier New',monospace" class="ink">Copy: <span style="user-select:all;-webkit-user-select:all;background:#FFF2E6;padding:2px 6px;border-radius:6px">${esc(code)}</span></p>
        <p style="margin:16px 0 0">Enter it at binchika.com/join within <strong>${esc(hours)} hours</strong>. After that the seat passes to the next applicant. You will set a password, then confirm your email and sign the verifier pledge.</p>
        ${button(link, "Claim my seat")}
        <p style="margin:12px 0 0;color:#5B5F67" class="muted">The code works once, and only with the email address you applied with. If you didn't apply, ignore this email. Binchika will never ask for your password, BVN or bank details.</p>`,
    }),
  };
}

/** Confirmation link after the seat is claimed (step 4): confirms the email and opens the pledge. */
export function seatConfirmation({ seat, publicId, area, link }) {
  return {
    subject: `Confirm seat ${seat}: sign your verifier pledge`,
    html: shell({
      preheader: `One step left: confirm your email and sign the pledge. The link expires in 24 hours.`,
      title: `Confirm seat ${seat}`,
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">${esc(seat)} · ${esc(area)} · ${esc(publicId)}</p>
        <h1 style="margin:0 0 10px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">Confirm seat ${esc(seat)}</h1>
        <p style="margin:0">Your account is set up. Your public ID is <strong>${esc(publicId)}</strong>. To activate the seat, confirm this email address and sign the verifier pledge by typing your full name, exactly as on your application.</p>
        ${button(link, "Confirm and sign the pledge")}
        <p style="margin:12px 0 0;color:#5B5F67" class="muted">The link expires in 24 hours and works once. If it lapses, the seat is released and offered to the next applicant.</p>`,
    }),
  };
}

/** Magic-link sign-in; with reset=true, the fallback for a forgotten password (sign in, then set a new one). */
export function signInLink({ link, seat, reset = false }) {
  return {
    subject: reset ? "Reset your Binchika access" : "Your Binchika sign-in link",
    html: shell({
      preheader: reset ? "Use this link to regain access. It works once and expires within an hour." : "One tap to sign in. The link works once and expires within an hour.",
      title: reset ? "Reset your access" : "Sign in to Binchika",
      body: `<h1 style="margin:0 0 8px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">${reset ? "Reset your access" : "Sign in"}${seat ? `, ${esc(seat)}` : ""}</h1>
        <p style="margin:0">${reset ? "Forgot your password? Use this one-time link to sign in, then set a new password under Account in your dashboard." : "Tap the button to sign in to your verifier dashboard without your password."} It works once and expires within an hour. Admin roles will still be asked for their authenticator code.</p>
        ${button(link, reset ? "Regain access" : "Sign in to Binchika")}
        <p style="margin:12px 0 0;font-size:13px;color:#5B5F67;word-break:break-all" class="muted">Or paste this link into your browser: ${esc(link)}</p>`,
    }),
  };
}

/** Meeting announcement to selected regions/states/roles. Recipients addressed by seat only. */
export function meetingInvite({ seat, title, whenWAT, link, agenda = [], audience, channel = "signal" }) {
  const signal = channel === "signal";
  return {
    subject: `Meeting: ${title} · ${whenWAT}`,
    html: shell({
      preheader: `${whenWAT} · ${audience}`,
      title,
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">Verifier meeting · ${esc(audience)}</p>
        <h1 style="margin:0 0 10px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">${esc(title)}</h1>
        <p style="margin:0">Hello ${esc(seat)},</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0;width:100%"><tr><td class="tile" style="background:#F3F1EC;border:1px solid #E1DCD1;border-radius:12px;padding:14px 16px">
          <p style="margin:0;font:700 18px Arial" class="ink">${esc(whenWAT)}</p><p style="margin:4px 0 0;color:#5B5F67" class="muted">West Africa Time (UTC+1)</p></td></tr></table>
        ${agenda.length ? `<p style="margin:0 0 4px;font-weight:700">Agenda</p><ol style="margin:0;padding-left:20px">${agenda.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>` : ""}
        ${button(link, signal ? "Join the Signal call" : "Join the meeting")}
        <p style="margin:10px 0 0;font-size:14px;color:#5B5F67" class="muted">Please set your Signal profile name to your seat number (${esc(seat)}) and join with that name only. Do not use your real name, and never share a phone number.</p>
        ${signal ? `<p style="margin:10px 0 0;font-size:14px;color:#5B5F67" class="muted"><strong>Signal, username only.</strong> Before the call, hide your number: Settings → Privacy → Phone number → set both options to <em>Nobody</em>. Never share a phone number in the meeting. Full guide: <a href="https://binchika.com/portal/rulebook/#signal" style="color:#983F14">rule book, section 8</a>.</p>` : ""}`,
    }),
  };
}

/** Welcome packet summary (full rule book lives at /portal/rulebook/). */
export function welcomePacket({ seat, publicId, role, area }) {
  return {
    subject: `Welcome, ${seat}: your Binchika rule book`,
    html: shell({
      preheader: `You hold seat ${seat}. Here is how the role works.`,
      title: `Welcome, ${seat}`,
      body: `<h1 style="margin:0 0 8px;font:800 26px/1.2 Arial,Helvetica,sans-serif" class="ink">Welcome, ${esc(seat)}.</h1>
        <p style="margin:0">You now hold seat <strong>${esc(seat)}</strong> as ${role === "nrv" ? "a Regional Verifier" : "a State Zone Verifier"} for <strong>${esc(area)}</strong>. Your public ID is <strong>${esc(publicId)}</strong>. That is how everyone, including us, will address you.</p>
        <ol style="margin:14px 0 0;padding-left:20px">
          <li><strong>Flag, never edit.</strong> You raise flags; only the BinchikAdmin approves corrections, and every correction is public.</li>
          <li><strong>Your area only.</strong> ${role === "nrv" ? "You review flags from the states in your region and escalate with findings." : "You read reports and raise flags for your own state."}</li>
          <li><strong>Stay anonymous.</strong> Use your seat number in every meeting and message. Never share your real name with other verifiers.</li>
          <li><strong>No party, no pay.</strong> Report any offer of money or pressure through the portal straight away.</li>
          <li><strong>Evidence over opinion.</strong> Every flag needs a reason someone else can check.</li>
        </ol>
        ${button("https://binchika.com/portal/rulebook/", "Read the full rule book")}`,
    }),
  };
}

/** OpsAdmin appointment by the BinchikAdmin (never by invite code). Carries a one-time sign-in link. */
export function opsAppointed({ seat, publicId, link }) {
  return {
    subject: `You have been appointed OpsAdmin ${seat}`,
    html: shell({
      preheader: `OpsAdmin seat ${seat}. Sign in, then set up your authenticator app.`,
      title: `OpsAdmin ${seat}`,
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">OpsAdmin · ${esc(seat)} · ${esc(publicId)}</p>
        <h1 style="margin:0 0 10px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">You are now OpsAdmin ${esc(seat)}.</h1>
        <p style="margin:0">The BinchikAdmin has appointed you to one of the three OpsAdmin seats. You help run reviews and operations. You cannot approve corrections, release seats or invite verifiers: those stay with the BinchikAdmin.</p>
        <ol style="margin:14px 0 0;padding-left:20px">
          <li>Tap the button to sign in. The link works once and expires within an hour.</li>
          <li>Scan the QR code with an authenticator app and enter the 6-digit code. Admin tools stay locked until you do.</li>
          <li>Set a password under <strong>Settings / Account</strong>.</li>
        </ol>
        ${button(link, "Sign in as OpsAdmin")}
        <p style="margin:12px 0 0;color:#5B5F67" class="muted">This email address is now locked to seat ${esc(seat)} and cannot be changed. If you did not expect this, reply through the contact form and do not sign in.</p>`,
    }),
  };
}

/** Acknowledgement after a verifier application is stored (eligible or needs review). */
export function applicationReceived({ role, area, review = false }) {
  return {
    subject: "We received your Binchika verifier application",
    html: shell({
      preheader: review ? "Thank you. One of your answers needs a human review." : "Thank you. Here is what happens next.",
      title: "Application received",
      body: `<p style="margin:0 0 6px;font:700 13px Arial;letter-spacing:.08em;text-transform:uppercase;color:#983F14">${role === "nrv" ? "Regional Verifier (NRV)" : "State Zone Verifier (SZV)"} · ${esc(area)}</p>
        <h1 style="margin:0 0 10px;font:800 24px/1.2 Arial,Helvetica,sans-serif" class="ink">Application received.</h1>
        <p style="margin:0">${review ? "Thank you for applying. You answered \"not sure\" to question 7 (flagging a mismatch even if it hurts a party you like), so a person will review your application before screening." : "Thank you for applying. Your answers meet the published screening rules."}</p>
        <ol style="margin:14px 0 0;padding-left:20px">
          <li>Screening uses the same published questions for everyone, plus a regional spread check.</li>
          <li>If you are selected, a seat code arrives by email from noreply@binchika.com. It is the only way seats are offered.</li>
          <li>You then claim the seat at binchika.com/join, confirm your email and sign the verifier pledge with the full name you gave us.</li>
        </ol>
        <p style="margin:14px 0 0;color:#5B5F67" class="muted">To withdraw or to see, correct or delete your data, use the <a href="https://binchika.com/contact/?topic=verifier" style="color:#983F14">contact page</a>. Binchika will never ask for payment, your password, BVN or bank details.</p>`,
    }),
  };
}

/**
 * General-purpose branded message for the BinchikAdmin: outreach, verifier communications and replies.
 * Used by the dashboard's Inbox & Sent tab (/api/admin/mail/send). The body is the admin's own plain text,
 * turned into paragraphs by textToHtml(); the "From" mailbox signs it. See docs/emails/README.md.
 * @param {{ subject: string, bodyHtml: string, signOff: string, from: string, preheader?: string, quoted?: string }} m
 */
export function general({ subject, bodyHtml, signOff, from, preheader, quoted, footer }) {   // footer: caller-escaped HTML (campaign unsubscribe line, session 96)
  return {
    subject,
    html: shell({
      preheader: preheader ?? subject,
      title: subject,
      logo: AGOGO,
      reason: `Sent by ${esc(signOff)} (${esc(from)}). Reply to this email to reach us.`,
      body: `${bodyHtml}
        <p style="margin:18px 0 0;font:700 15px Arial,Helvetica,sans-serif" class="ink">${esc(signOff)}</p>
        <p style="margin:2px 0 0;font:13px Arial,Helvetica,sans-serif;color:#5B5F67" class="muted"><a href="https://binchika.com/" style="color:#983F14">binchika.com</a> · ${esc(from)}</p>
        ${quoted ? `<div style="margin:22px 0 0;padding:10px 0 0 12px;border-left:3px solid #E1DCD1;font:13px/1.5 Arial,Helvetica,sans-serif;color:#5B5F67" class="muted">${quoted}</div>` : ""}
        <p style="margin:18px 0 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#5B5F67" class="muted">Binchika will never ask for payment, your password, BVN or bank details.</p>${footer ? `
        <p style="margin:10px 0 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#5B5F67" class="muted">${footer}</p>` : ""}`,
    }),
  };
}
