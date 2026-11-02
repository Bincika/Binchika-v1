// Verifier screening rules: the same published questions for everyone. Shared by the browser self-check
// (copied to site/assets/js/lib/ by scripts/build-site.mjs) and by /api/apply, so both judge identically.

// [question, disqualifying answer, why]
export const RULES = [
  ["q1", "yes", "Verifying is unpaid volunteer work. Expecting payment rules you out, which protects verifiers from anyone trying to buy influence."],
  ["q2", "yes", "Current party or campaign roles are a conflict of interest. You can still take part as an independent citizen monitor."],
  ["q3", "yes", "Recent party office or candidacy is a conflict of interest for verifier roles. You are welcome as a citizen monitor."],
  ["q4", "yes", "Election officials can't check their own work. Thank you for serving."],
  ["q5", "no", "Verifiers must be 18 or older and hold a valid voter card."],
  ["q6", "no", "Election days and the 72 hours after each are when verifiers are needed most."],
  ["q7", "no", "Verifiers must report what the sheets show, whoever it helps."],
  ["q8", "yes", "Accredited observers already have a formal role in this election, so holding a verifier seat too would be a conflict of interest."],
];
const ALLOWED = { q7: ["yes", "no", "unsure"] };

/**
 * → { status: "incomplete" | "ineligible" | "submitted" (needs review) | "eligible", reasons, missing, score }
 * Eligible applicants all score the same: no favours; ties go to whoever applied first.
 */
export function screen(answers = {}) {
  const missing = RULES.map(([q]) => q).filter((q) => !(ALLOWED[q] ?? ["yes", "no"]).includes(answers[q]));
  if (missing.length) return { status: "incomplete", missing, reasons: [], score: 0 };
  const reasons = RULES.filter(([q, bad]) => answers[q] === bad).map(([, , why]) => why);
  if (reasons.length) return { status: "ineligible", missing: [], reasons, score: 0 };
  if (answers.q7 === "unsure") return { status: "submitted", missing: [], reasons: [], score: 50 };
  return { status: "eligible", missing: [], reasons: [], score: 100 };
}

/** Only the answers we ask for, as plain strings (nothing else from the request is stored). */
export const cleanAnswers = (a = {}) => Object.fromEntries(RULES.map(([q]) => [q, String(a[q] ?? "")]));
