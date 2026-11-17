// Words the verifier screen uses for a polling unit's standing and for photos the machine did not read (session 150;
// audit of 16 November 2026). Hand-written; no build step. Only "high" is posted and counted, so every other standing
// begins "Not counted": a verifier must never mistake "nearly high" for a figure that is in the public totals.

const REASON = {
  held: "high, but held back by a check",
  lower: "lower confidence",
  medium: "not yet high",
  low: "not yet high",
  insufficient: "not enough readings",
};

/** @param {string} status unit_consensus.status */
export function unitLabel(status) {
  if (status === "high") return "High confidence, posted";
  return REASON[status] ? `Not counted (${REASON[status]})` : "Not counted";
}

// The contained OCR path refuses any photo the people check has not cleared (functions/_lib/ocr.js: faceCheck !== "none").
export const MACHINE_DID_NOT_READ = "The machine did not read this photo";
/** The same sentence, saying "video" for a video (videos are never checked for people, so never read). */
export const machineSentence = (report) => (report?.evidence === "video" ? "The machine did not read this video" : MACHINE_DID_NOT_READ);

/** True when the reading has a stored photo that the people check has not cleared ("detected", "unchecked" or no value). */
export function machineDidNotRead(report) {
  return Boolean(report?.has_media) && report.face_check !== "none";
}
