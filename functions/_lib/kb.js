// Knowledge base for common enquiries, phase K1 (session 80; docs/KNOWLEDGE-BASE-DESIGN.md). No AI. Answers live in
// src/kb/*.md: a JSON header (topics, match words, the exact published sentences they rely on) and the answer text.
// The build checks every sentence against the built pages and refuses to build if one is missing, writes /help/, and
// writes kb.generated.js for the Tickets API. Matching is plain word rules, so every suggestion can be explained.
// A person always reads and sends; nothing here sends anything. Pure; shared by the build, the API and tests.

/** Topics that never get a stock answer: identity checks, parties and manifestos, press, possible ledger corrections. */
export const NEVER_NATURES = ["data", "party", "manifesto", "press", "error"];
export const KB_THRESHOLD = 0.6;

/** Parse one src/kb file. Throws with the file name if the header is missing or incomplete. */
export function parseKb(text, name = "kb entry") {
  const m = String(text).match(/^<!--(\{[\s\S]*?\})-->\s*/);
  if (!m) throw new Error(`${name}: missing JSON header`);
  const meta = JSON.parse(m[1]);
  for (const k of ["id", "question", "topics", "match", "sources", "link", "approved", "review_by"]) if (meta[k] === undefined) throw new Error(`${name}: header needs "${k}"`);
  if (meta.auto_send) throw new Error(`${name}: automatic sending is not switched on in phase K1`);
  if (!meta.sources.length || meta.sources.some((s) => !s.page || !s.must_contain)) throw new Error(`${name}: every answer needs at least one { page, must_contain } source`);
  if (meta.topics.some((t) => NEVER_NATURES.includes(t))) throw new Error(`${name}: topics ${NEVER_NATURES.join(", ")} never get a stock answer`);
  const body = text.slice(m[0].length).trim();
  if (!body) throw new Error(`${name}: empty answer`);
  return { ...meta, body };
}

/** Lower case, accents and punctuation removed, single spaces, padded so " word " tests whole words. */
export const normalise = (s) => ` ${String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
// "verif*" matches any word starting "verif"; "how long" matches the phrase; "pay" matches the whole word only.
const has = (t, term) => {
  const n = normalise(term.replace(/\*$/, "")).trim();
  return term.endsWith("*") ? t.includes(` ${n}`) : t.includes(` ${n} `);
};

/**
 * Score every answer against one enquiry. Returns matches at or above the threshold, best first.
 * Needs a word from every all_of group and at least one any_of word, and the topic must fit (else no match).
 * Score: 0.4 for the all_of groups, + 0.4 × (any_of words found, up to 2) / 2, + 0.2 for the topic: 0.8 or 1.0.
 * @param {object[]} entries  parsed answers
 * @param {{ nature?: string, text: string }} q
 */
export function matchKb(entries, { nature, text }) {
  if (NEVER_NATURES.includes(nature)) return [];
  const t = normalise(text);
  const out = [];
  for (const e of entries) {
    if (nature && !e.topics.includes(nature)) continue;
    if ((e.match.never ?? []).some((w) => has(t, w))) continue;
    const groups = (e.match.all_of ?? []).map((g) => g.filter((w) => has(t, w)));
    if (groups.some((g) => g.length === 0)) continue;
    const any = (e.match.any_of ?? []).filter((w) => has(t, w));
    if (!any.length) continue;   // the subject word alone is not a question; at least one question word must appear
    const score = Math.round((0.4 + 0.4 * Math.min(any.length, 2) / 2 + 0.2) * 100) / 100;
    if (score >= KB_THRESHOLD) out.push({ id: e.id, question: e.question, score, matched: [...new Set([...groups.flat(), ...any])].map((w) => w.replace(/\*$/, "")) });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** The words of an Inbox enquiry worth matching: subject without its [BIN-… · Topic] tag, and the message without the form's header and footer lines. */
export function enquiryText(subject, body) {
  const s = String(subject ?? "").replace(/^\s*\[[^\]]*\]\s*/, "");
  const b = String(body ?? "").split("\n").filter((l) => !/^(Reference|Nature|Party|From|Sent|Attachments):/.test(l) && !/^— Sent via the contact form/.test(l)).join("\n");
  return `${s}\n${b}`.slice(0, 6000);
}

/** The reply a person checks and sends. The dashboard's template adds the sign-off (the mailbox name). */
export function replyText(entry, ref) {
  const tail = /^BIN-\d{4}-\d{4,}$/.test(String(ref ?? "")) ? `\n\nYour reference is ${ref}. If this does not answer your question, just reply and a person will help.` : "\n\nIf this does not answer your question, just reply and a person will help.";
  return `Hello,\n\nThank you for asking. ${entry.body}${tail}`;
}

/** Visible text of built HTML, for the drift check: tags removed, entities decoded, whitespace collapsed. */
export function pageText(html) {
  const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rarr: "→", ndash: "–", mdash: "—", middot: "·", hellip: "…" };
  return String(html)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?(strong|b|i|em|span|a|code|abbr|small|sup|sub|mark|u|time|q)(?=[\s>\/])[^>]*>/gi, "")   // inline: no gap
    .replace(/<[^>]+>/g, " ")                                                                   // block: a gap
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ent[e.toLowerCase()] ?? all))
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:)])/g, "$1")
    .trim();
}

/** Every source sentence that is no longer on its page. An empty list means the answers are up to date. */
export function kbDrift(entries, readPage) {
  const cache = new Map();
  const missing = [];
  for (const e of entries) for (const s of e.sources) {
    if (!cache.has(s.page)) { try { cache.set(s.page, pageText(readPage(s.page))); } catch { cache.set(s.page, null); } }
    const t = cache.get(s.page);
    if (t === null) missing.push(`${e.id}: page ${s.page} not found`);
    else if (!t.includes(s.must_contain)) missing.push(`${e.id}: "${s.must_contain}" is no longer on ${s.page}`);
  }
  return missing;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** The /help/ page body: one expandable answer per entry, with its source link. */
export function helpHtml(entries) {
  return entries.map((e) => {
    // A paragraph is text lines, then optionally bullet lines ("• "); bullets followed by more text are refused.
    const blocks = e.body.split(/\n\s*\n/).map((p) => {
      const lines = p.split("\n");
      const first = lines.findIndex((l) => l.startsWith("• "));
      const text = first === -1 ? lines : lines.slice(0, first), bullets = first === -1 ? [] : lines.slice(first);
      if (bullets.some((l) => !l.startsWith("• "))) throw new Error(`${e.id}: keep bullet lines ("• ") at the end of their paragraph`);
      return `${text.length ? `<p>${esc(text.join(" "))}</p>` : ""}${bullets.length ? `<ul class="tick-list">${bullets.map((l) => `<li>${esc(l.slice(2))}</li>`).join("")}</ul>` : ""}`;
    }).join("");
    return `<details class="kb-item panel" id="${esc(e.id)}"><summary><h2>${esc(e.question)}</h2></summary>${blocks}<p class="source-note">From <a href="${esc(e.link)}">binchika.com${esc(e.link)}</a>.</p></details>`;
  }).join("\n");
}
