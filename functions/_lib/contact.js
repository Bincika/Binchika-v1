// Contact form validation and routing. Pure; shared by the API and tests.

export const NATURES = {
  manifesto: { label: "Party manifesto or motto submission", from: "Binchika Accounts <accounts@binchika.com>" },
  party: { label: "Party communication", from: "Binchika Accounts <accounts@binchika.com>" },
  data: { label: "Data request", from: "Binchika Accounts <accounts@binchika.com>" },
  error: { label: "Report an error in our data", from: "Binchika Ops <ops@binchika.com>" },
  verifier: { label: "Verifier question", from: "Binchika Ops <ops@binchika.com>" },
  technical: { label: "Website or technical issue", from: "Binchika Ops <ops@binchika.com>" },
  press: { label: "Press and media", from: "Binchika <noreply@binchika.com>" },
  // Session 91: a newsroom asks to be registered for the press feed (functions/_lib/media.js). Reviewed under Tickets.
  media_access: { label: "Media access request (press feed)", from: "Binchika Ops <ops@binchika.com>" },
  other: { label: "Something else", from: "Binchika <noreply@binchika.com>" },
};
export const MAX_FILES = 5;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|text\/(plain|csv)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/;
export const MIN_FILL_MS = 3000;

/** @param {{nature, name, email, message, website, renderedAt, files: {name, type, size}[]}} f */
export function validateContact(f, now = Date.now()) {
  const errors = [];
  if (f.website) errors.push("spam");                       // honeypot must stay empty
  if (!(Number(f.renderedAt) > 0) || now - Number(f.renderedAt) < MIN_FILL_MS) errors.push("too fast");
  if (!NATURES[f.nature]) errors.push("choose the nature of your enquiry");
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i.test(f.email ?? "")) errors.push("a valid email is needed so we can reply");
  if (String(f.name ?? "").length > 100) errors.push("name too long");
  const msg = String(f.message ?? "").trim();
  if (msg.length < 20 || msg.length > 5000) errors.push("message must be 20–5000 characters");
  const files = f.files ?? [];
  if (files.length > MAX_FILES) errors.push(`at most ${MAX_FILES} attachments`);
  if (files.reduce((a, x) => a + (x.size ?? 0), 0) > MAX_TOTAL_BYTES) errors.push("attachments over 10 MB in total");
  for (const x of files) if (!ALLOWED_TYPES.test(x.type ?? "")) errors.push(`file type not accepted: ${x.name}`);
  return { ok: errors.length === 0, errors };
}

/** With a ticket reference (session 78) the tag is "[BIN-2611-0042 · Topic]"; without one it stays "[Binchika · Topic]". */
export function subjectFor(f, ref = null) {
  const n = NATURES[f.nature]?.label ?? "Enquiry";
  const first = String(f.message).trim().split(/\s+/).slice(0, 8).join(" ");
  return `[${ref ?? "Binchika"} · ${n}] ${first}${String(f.message).trim().split(/\s+/).length > 8 ? "…" : ""}`.slice(0, 180);
}
