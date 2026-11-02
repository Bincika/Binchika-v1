// Form EC8A rules applied on ingest and before the ledger (session 88; docs/reports/2026-11-01-production-readiness.md).
// Promoted from the session 87 sandbox (sandbox/readiness/ec8a-rules.mjs) into the live pipeline. Pure; shared by the
// API, the pipeline, scripts and tests. Fail closed: anything these rules cannot confirm stays out of the count.

// ---------- Polling-unit codes ----------
// INEC codes are state-lga-ward-unit (24-09-05-012). They carry no check digit, so the equivalent check is positional:
// the state must be 01–37, the LGA must exist in that state (INEC numbers a state's LGAs 01…N), and ward and unit must
// be non-zero. LGA counts per INEC state code, from site/data/states.json (774 in all); a unit test keeps them in step.
export const LGA_COUNT = {
  "01": 17, "02": 21, "03": 31, "04": 21, "05": 20, "06": 8, "07": 23, "08": 27, "09": 18, "10": 25, "11": 13, "12": 18,
  "13": 16, "14": 17, "15": 11, "16": 27, "17": 27, "18": 23, "19": 44, "20": 34, "21": 21, "22": 21, "23": 16, "24": 20,
  "25": 13, "26": 25, "27": 20, "28": 18, "29": 30, "30": 33, "31": 17, "32": 23, "33": 23, "34": 16, "35": 17, "36": 14, "37": 6,
};
const PU = /^\d{2}-\d{2}-\d{2}-\d{3}$/;

/** null when the code is a plausible INEC polling unit; otherwise a short reason for the person who sent it. */
export function puProblem(code) {
  const t = String(code ?? "");
  if (!PU.test(t)) return "must look like 24-09-05-012";
  const [state, lga, ward, unit] = t.split("-");
  if (!LGA_COUNT[state]) return `state ${state} is not an INEC state code (01–37)`;
  if (Number(lga) < 1 || Number(lga) > LGA_COUNT[state]) return `LGA ${lga} does not exist in state ${state} (01–${String(LGA_COUNT[state]).padStart(2, "0")})`;
  if (Number(ward) < 1) return "ward cannot be 00";
  if (Number(unit) < 1) return "unit cannot be 000";
  return null;
}

// ---------- Ballot conditions published on /vote/ ----------
// The six cases are about single ballots. On a result sheet their effect is one rule: a void ballot is a rejected ballot,
// recorded in the "rejected" box and never added to any party. So a tally may not contain a party called VOID,
// REJECTED, SPOILT and so on; void ballots must arrive as controls.rejected.
export const BALLOT_CASES = [
  { id: "one-box", verdict: "valid", detail: "One clear thumbprint inside one box." },
  { id: "split", verdict: "void", detail: "A print split equally between two boxes." },
  { id: "multi", verdict: "void", detail: "Prints for more than one party." },
  { id: "blank", verdict: "void", detail: "No thumbprint at all." },
  { id: "name", verdict: "void", detail: "Your name or any mark that identifies you." },
  { id: "outside", verdict: "void", detail: "A print outside every box." },
];
export const NOT_A_PARTY = /^(VOID|VOIDS|REJ|REJECT|REJECTED|SPOIL|SPOILT|SPOILED|INVALID|BLANK|NULL|CANCEL|CANCELLED|TOTAL|VALID|CAST|ACCRED)$/;

/** A described ballot: valid only with exactly one print, inside exactly one box, and nothing that identifies the voter. */
export function ballotVerdict({ marks, boxes, identifies = false, outside = false }) {
  return !identifies && !outside && marks === 1 && boxes === 1 ? "valid" : "void";
}

// ---------- Control totals ----------
const whole = (n) => Number.isInteger(n) && n >= 0;

/**
 * The control totals of one Form EC8A against its party tally.
 * controls: { register, accredited, rejected, spoiled?, valid?, cast?, cancelled? }
 * Rules: a cancelled unit has no tally; party votes are whole numbers and never include void ballots; valid = sum of
 * parties (if the sheet states it); cast = valid + rejected (if stated); cast ≤ accredited ≤ register.
 * @returns {{ ok: boolean, present: boolean, errors: string[], valid: number|null, cast: number|null }}
 */
export function assessControls(controls, tally) {
  if (controls == null) return { ok: false, present: false, errors: ["No control totals were sent, so the sheet cannot be balanced."], valid: null, cast: null };
  const errors = [];
  if (controls.cancelled === true) {
    if (tally && Object.keys(tally).length) errors.push("The polling unit is marked cancelled, so no tally is eligible.");
    return { ok: false, present: true, cancelled: true, errors: errors.length ? errors : ["The polling unit is marked cancelled."], valid: null, cast: null };
  }
  const parties = tally ?? {};
  for (const k of Object.keys(parties)) if (NOT_A_PARTY.test(k)) errors.push(`"${k}" is not a party. Void ballots go in the rejected total, never in a party.`);
  const valid = Object.values(parties).reduce((a, n) => a + (whole(n) ? n : 0), 0);
  const { register, accredited, rejected } = controls;
  if (!whole(register) || register === 0) errors.push("The register must be a positive whole number.");
  if (!whole(accredited)) errors.push("Accredited voters must be a whole number of zero or more.");
  if (!whole(rejected)) errors.push("Rejected ballots must be a whole number of zero or more.");
  if (controls.spoiled != null && !whole(controls.spoiled)) errors.push("Spoiled ballots must be a whole number of zero or more.");
  if (controls.valid != null && controls.valid !== valid) errors.push(`The sheet's valid votes (${controls.valid}) do not equal the party total (${valid}).`);
  const cast = valid + (whole(rejected) ? rejected : 0);
  if (controls.cast != null && controls.cast !== cast) errors.push(`The sheet's votes cast (${controls.cast}) do not equal valid votes plus rejected ballots (${cast}).`);
  if (whole(accredited) && cast > accredited) errors.push(`Votes cast (${cast}) exceed accredited voters (${accredited}).`);
  if (whole(accredited) && whole(register) && accredited > register) errors.push(`Accredited voters (${accredited}) exceed the register (${register}).`);
  return { ok: errors.length === 0, present: true, errors, valid, cast };
}

// ---------- Posting gates: what may reach the ledger ----------
/**
 * Every gate must pass before a unit's tally is posted. IReV agreement is deliberately not a gate: a difference is
 * stored on the entry and the citizen tally is still published (constitution §4); it is shown as a mismatch.
 * @param {{ puCode: string, consensus: { status: string }, counted: { checksOk: boolean }[], baseline: { severity: string } | null }} u
 * @returns {{ post: boolean, score: number, gates: { id: string, pass: boolean, why: string }[] }}
 */
export function postingGates({ puCode, consensus, counted, baseline }) {
  const gates = [
    { id: "polling-unit", pass: puProblem(puCode) === null, why: "a real INEC polling-unit position" },
    { id: "consensus", pass: consensus?.status === "high", why: "at least three independent reports agreeing at 85% or more" },
    { id: "human-or-confident", pass: counted.length > 0, why: "every counted reading confirmed by a verifier (or a confident machine reading)" },
    { id: "control-totals", pass: counted.length > 0 && counted.every((r) => r.checksOk), why: "every counted sheet balances: cast = valid + rejected ≤ accredited ≤ register" },
    { id: "baseline", pass: (baseline?.severity ?? "none") !== "critical", why: "no count above the register (baseline check)" },
  ];
  const passed = gates.filter((g) => g.pass).length;
  return { post: passed === gates.length, score: Math.round((passed / gates.length) * 100), gates };
}

// ---------- Human-readable report status (portal) ----------
export const STATUS_LABEL = {
  received: "Received",
  ocr_pending: "Waiting for a reading",
  ocr_done: "Read by machine (confident)",
  needs_review: "Needs a verifier's check",
  verified: "Confirmed by a verifier",
  rejected: "Rejected",
};
