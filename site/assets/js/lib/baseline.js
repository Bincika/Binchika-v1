// Pre-election baseline checks. The register is frozen before polling, so on election day the
// announced "registered voters" for an area should match the baseline, and no count of accredited
// voters or votes cast can exceed it. Pure; shared by API, scripts and tests.

export const MATERIAL_PCT = 0.5;   // % change in a frozen register that is "material"
export const MATERIAL_ABS = 500;   // …or this many voters, whichever is larger

/**
 * @param {number} baseline registered voters before the election (INEC, timestamped)
 * @param {{registered?: number, accredited?: number, votesCast?: number}} announced figures on/after election day
 * @returns {{severity: 'none'|'material'|'critical', findings: {field:string, baseline:number, announced:number, delta:number, pct:number, reason:string}[]}}
 */
export function checkAgainstBaseline(baseline, announced) {
  const findings = [];
  if (!Number.isFinite(baseline) || baseline <= 0) return { severity: "none", findings };
  const pct = (a) => Math.round(((a - baseline) / baseline) * 10000) / 100;
  if (Number.isFinite(announced.registered) && announced.registered !== baseline) {
    const delta = announced.registered - baseline;
    if (Math.abs(delta) >= Math.max(MATERIAL_ABS, (baseline * MATERIAL_PCT) / 100)) {
      findings.push({ field: "registered", baseline, announced: announced.registered, delta, pct: pct(announced.registered), reason: "Registered voters changed after the register was frozen" });
    }
  }
  for (const field of ["accredited", "votesCast"]) {
    const v = announced[field];
    if (Number.isFinite(v) && v > baseline) {
      findings.push({ field, baseline, announced: v, delta: v - baseline, pct: pct(v), reason: `${field === "accredited" ? "Accredited voters" : "Votes cast"} exceed registered voters` });
    }
  }
  const severity = findings.some((f) => f.field !== "registered" || f.delta > 0) ? "critical" : findings.length ? "material" : "none";
  return { severity, findings };
}

/** Normalises LGA names across INEC documents and GRID3 boundaries (e.g. "OGORI MANGOGO" ≈ "Ogori/Magongo"). */
export function lgaKey(name) {
  const k = String(name).toUpperCase().replace(/LOCAL GOVERNMENT( AREA)?|\bLGA\b/g, "").replace(/[^A-Z]/g, "");
  return LGA_ALIASES[k] ?? k;
}

// Known spelling differences between INEC documents and GRID3 boundaries (INEC key → GRID3 key).
export const LGA_ALIASES = {
  YENEGOA: "YENAGOA",
  MBATOLI: "MBAITOLI",
  EZINIHITTE: "EZINIHITTEMBAISE",
  OGORIMANGOGO: "OGORIMAGONGO",
  KOGIKK: "KOGI",
  MOPAMURO: "MOPAMORO",
};
