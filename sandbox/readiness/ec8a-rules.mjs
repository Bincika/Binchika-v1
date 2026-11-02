// Sandbox rules for the 1 November 2026 production-readiness test.
// These functions are not wired into the live pipeline. They describe the checks a Form EC8A
// reading must pass before anyone may treat it as a tally proposal. UK English in messages.

/** Press report of INEC's 1 March 2023 declaration (ThisDay). Not an INEC PDF fetched in this session. */
export const NATIONAL_2023 = {
  verified: false,
  source: "ThisDay, 1 March 2023, reporting INEC's declaration. Registered voters match this project's 2023 baseline (93,469,008).",
  sourceUrl: "https://www.thisdaylive.com/2023/03/01/updated-inec-declares-tinubu-winner-of-2023-presidential-election/",
  registered: 93469008,
  accredited: 25286616,
  valid: 24025940,
  rejected: 939278,
  cast: 24965218,
  parties: { APC: 8794726, PDP: 6984520, LP: 6101533, NNPP: 1496687 },
};

/** Illustrative polling-unit split. Same shares as the four published national totals, scaled to a fictional unit. */
export function illustrativeUnit(register = 480) {
  const main = NATIONAL_2023.parties;
  const mainSum = Object.values(main).reduce((a, n) => a + n, 0);
  const accredited = Math.round(register * (NATIONAL_2023.accredited / NATIONAL_2023.registered));
  const validTarget = Math.round(accredited * (NATIONAL_2023.valid / NATIONAL_2023.accredited));
  const parties = {};
  let used = 0;
  for (const [party, votes] of Object.entries(main)) {
    const n = Math.round(validTarget * (votes / mainSum));
    parties[party] = n;
    used += n;
  }
  const rejected = Math.max(0, Math.round(accredited * (NATIONAL_2023.rejected / NATIONAL_2023.accredited)));
  return {
    fictional: true,
    label: "Fictional sandbox unit. Shares follow the 2023 national declaration. This is not an INEC polling-unit result.",
    puCode: "37-01-01-901",
    race: "president",
    register,
    accredited,
    rejected,
    spoiled: 4,
    parties,
    valid: used,
    cast: used + rejected,
  };
}

/**
 * Control totals for one sheet.
 * Rejected ballots are never added to a party. A cancelled unit has no tally.
 * @param {{cancelled?: boolean, register: number, accredited: number, rejected: number, spoiled?: number, parties: Record<string, number>}} sheet
 */
export function assessSheet(sheet) {
  const errors = [];
  if (sheet.cancelled) return { ok: false, eligible: false, reason: "cancelled", errors: ["The polling unit is marked cancelled. No tally is eligible."] };
  const parties = sheet.parties ?? {};
  for (const [party, votes] of Object.entries(parties)) {
    if (!/^[A-Z]{1,6}$/.test(party)) errors.push(`Party acronym ${party} is not a short code.`);
    if (!Number.isInteger(votes) || votes < 0) errors.push(`Votes for ${party} must be a whole number of zero or more.`);
  }
  const valid = Object.values(parties).reduce((a, n) => a + (Number.isInteger(n) ? n : 0), 0);
  const rejected = sheet.rejected ?? 0;
  const accredited = sheet.accredited;
  const register = sheet.register;
  if (!Number.isInteger(rejected) || rejected < 0) errors.push("Rejected ballots must be a whole number of zero or more.");
  if (!Number.isInteger(accredited) || accredited < 0) errors.push("Accredited voters must be a whole number of zero or more.");
  if (!Number.isInteger(register) || register <= 0) errors.push("The register must be a positive whole number.");
  if (Number.isInteger(accredited) && Number.isInteger(register) && accredited > register) errors.push("Accredited voters exceed the register.");
  const cast = valid + (Number.isInteger(rejected) ? rejected : 0);
  if (Number.isInteger(accredited) && cast > accredited) errors.push("Valid votes plus rejected ballots exceed accredited voters.");
  const spoiled = sheet.spoiled ?? 0;
  if (!Number.isInteger(spoiled) || spoiled < 0) errors.push("Spoiled ballots must be a whole number of zero or more.");
  return {
    ok: errors.length === 0,
    eligible: errors.length === 0,
    valid,
    cast,
    rejected: Number.isInteger(rejected) ? rejected : null,
    errors,
    reason: errors.length ? "control-totals" : "balanced",
  };
}

/** Six ballot conditions published on /vote/. A classifier for a described ballot, not a photo reader. */
export const BALLOT_CASES = [
  { id: "one-box", caption: "Valid", detail: "One clear thumbprint inside one box.", marks: 1, boxes: 1, identifies: false, outside: false, verdict: "valid" },
  { id: "split", caption: "Void", detail: "A print split equally between two boxes.", marks: 1, boxes: 2, identifies: false, outside: false, verdict: "void" },
  { id: "multi", caption: "Void", detail: "Prints for more than one party.", marks: 2, boxes: 2, identifies: false, outside: false, verdict: "void" },
  { id: "blank", caption: "Void", detail: "No thumbprint at all.", marks: 0, boxes: 0, identifies: false, outside: false, verdict: "void" },
  { id: "name", caption: "Void", detail: "Your name or any mark that identifies you.", marks: 1, boxes: 1, identifies: true, outside: false, verdict: "void" },
  { id: "outside", caption: "Void", detail: "A print outside every box.", marks: 1, boxes: 0, identifies: false, outside: true, verdict: "void" },
];

export function ballotVerdict({ marks, boxes, identifies, outside }) {
  if (identifies || outside || marks !== 1 || boxes !== 1) return "void";
  return "valid";
}

/** Stricter than the live regex: state 01–37, and every group numeric. No check digit exists in the INEC code. */
export function proposedPuProblem(puCode) {
  const text = String(puCode ?? "");
  if (!/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(text)) return "syntax";
  const state = Number(text.slice(0, 2));
  if (state < 1 || state > 37) return "state";
  const lga = Number(text.slice(3, 5));
  const ward = Number(text.slice(6, 8));
  const unit = Number(text.slice(9, 12));
  if (lga < 1 || ward < 1 || unit < 1) return "position";
  return null;
}

/** Per-field OCR gate from the AI governance note: below 0.9, a person confirms. */
export const FIELD_CONFIDENCE_MIN = 0.9;

export function ocrGate(fields) {
  const low = fields.filter((f) => !(Number(f.confidence) >= FIELD_CONFIDENCE_MIN) || f.read !== f.truth);
  return { eligible: fields.length > 0 && low.length === 0, low: low.map((f) => f.name) };
}

/**
 * A sheet may be offered to consensus only when the OCR gate and the control totals both pass,
 * and the unit is not cancelled. Offering it still does not write the ledger: consensus needs
 * at least three independent reports at 85% agreement, and that rule stays in consensus.js.
 */
export function proposalAllowed({ sheet, fields }) {
  const totals = assessSheet(sheet);
  const gate = ocrGate(fields);
  return { allowed: totals.eligible && gate.eligible, totals, gate };
}
