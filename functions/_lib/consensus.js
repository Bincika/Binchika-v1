// Polling-unit consensus rules (see PROJECT-CONSTITUTION.md §4).
// Pure functions, shared by Pages Functions, scripts and tests.

export const HIGH_SHARE = 0.85;
export const MIN_INDEPENDENT = 3;
export const MEDIUM_SHARE = 0.6;

/** Canonical key for a tally: parties sorted, zero counts dropped. */
export function tallyKey(tally) {
  return Object.entries(tally)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => [k.toUpperCase(), Math.trunc(Number(v))])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v}`)
    .join("|");
}

/**
 * @param {{reporterHash: string, tally: Record<string, number>, source?: string}[]} reports
 *   in arrival order; a later report from the same reporter replaces the earlier one.
 */
export function consensus(reports, { highShare = HIGH_SHARE, minIndependent = MIN_INDEPENDENT } = {}) {
  const latest = new Map();
  for (const rep of reports) latest.set(rep.reporterHash, rep);
  const independent = [...latest.values()];
  const n = independent.length;
  if (n === 0) return { status: "insufficient", reports: 0, share: 0, tally: null, dissent: [], tie: false };

  const groups = new Map();
  for (const rep of independent) {
    const key = tallyKey(rep.tally);
    const g = groups.get(key) ?? { key, tally: rep.tally, members: [] };
    g.members.push(rep);
    groups.set(key, g);
  }
  const ranked = [...groups.values()].sort((a, b) => b.members.length - a.members.length);
  const [top, second] = ranked;
  const tie = Boolean(second && second.members.length === top.members.length);
  const share = top.members.length / n;

  let status = "low";
  if (!tie && share >= highShare && n >= minIndependent) status = "high";
  else if (!tie && share >= MEDIUM_SHARE && n >= 2) status = "medium";

  return {
    status,
    reports: n,
    share: Math.round(share * 1000) / 1000,
    tally: tie ? null : Object.fromEntries(tallyKey(top.tally).split("|").filter(Boolean).map((s) => [s.split(":")[0], Number(s.split(":")[1])])),
    dissent: ranked.slice(1).map((g) => ({ key: g.key, count: g.members.length, sources: g.members.map((m) => m.source ?? null) })),
    tie,
  };
}

/**
 * Consensus for one polling unit, with the rule for when Form EC8A is not available (session 55):
 * - reports of the posted result sheet ("ec8a", the default) count exactly as in consensus();
 * - alternative evidence (video, handwritten numbers, a photo of the results board) counts only after a verifier has
 *   approved it (audit "approved"); pending and rejected alternatives are left out;
 * - if the result-sheet reports alone are high-confidence, that is the result, unchanged;
 * - otherwise, if approved alternatives are needed, the unit is at most "lower" (lower-confidence): never "high", so it
 *   never reaches the ledger or the results on its own.
 * @param {{reporterHash: string, tally: Record<string, number>, source?: string, evidence?: string, audit?: string|null}[]} reports in arrival order
 * @returns consensus() fields plus { evidence: "ec8a" | "mixed", alternatives, pendingAudit }
 */
export function unitConsensus(reports, opts) {
  const isAlt = (r) => (r.evidence ?? "ec8a") !== "ec8a";
  const usable = reports.filter((r) => !isAlt(r) || r.audit === "approved");
  const alternatives = usable.filter(isAlt).length;
  const pendingAudit = reports.filter((r) => isAlt(r) && r.audit !== "approved" && r.audit !== "rejected").length;
  const base = consensus(reports.filter((r) => !isAlt(r)), opts);
  if (base.status === "high" || alternatives === 0) return { ...base, evidence: "ec8a", alternatives: 0, pendingAudit };
  const mixed = consensus(usable, opts);
  return { ...mixed, status: mixed.status === "high" ? "lower" : mixed.status, evidence: "mixed", alternatives, pendingAudit };
}

/** Compare a consensus citizen tally with the official (IReV/INEC) tally. */
export function compareWithOfficial(citizen, official) {
  const norm = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k.toUpperCase(), Math.trunc(Number(v))]));
  const c = norm(citizen);
  const o = norm(official);
  const parties = [...new Set([...Object.keys(c), ...Object.keys(o)])].sort();
  const diffs = [];
  for (const party of parties) {
    const cv = c[party] ?? 0;
    const ov = o[party] ?? 0;
    if (cv !== ov) diffs.push({ party, citizen: cv, official: ov, delta: cv - ov });
  }
  return { match: diffs.length === 0, diffs };
}
