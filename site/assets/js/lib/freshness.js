// Freshness helpers for pages that show live figures (session 147; docs/egm/app-next/build-plan.md).
// They only decide WHEN to ask again and WHETHER an answer may be shown. Nothing is stored; no figure is ever kept
// for offline use. Every dependency can be passed in, so the rules are unit-tested.

const hidden = (doc) => Boolean(doc) && (doc.visibilityState === "hidden" || doc.hidden === true);

/**
 * Runs fn every ms, skipping turns while the page is hidden.
 * kick(): run now and restart the timer, so a timer turn cannot follow straight after a resume.
 */
export function pollWhileVisible(fn, ms, { documentRef = globalThis.document, setIntervalImpl = globalThis.setInterval?.bind(globalThis), clearIntervalImpl = globalThis.clearInterval?.bind(globalThis) } = {}) {
  let timer = null, stopped = false;
  const turn = () => { if (!stopped && !hidden(documentRef)) void fn(); };
  const start = () => { timer = setIntervalImpl(turn, ms); };
  const stop = () => { if (timer !== null) clearIntervalImpl(timer); timer = null; };
  start();
  return {
    stop: () => { stopped = true; stop(); },
    kick: () => { if (stopped) return; stop(); start(); turn(); },
  };
}

/**
 * Runs fn when the page comes back to the front or the network returns: never while hidden, and at most once
 * every minGapMs. Returns a function that removes the listeners.
 */
export function onResume(fn, { documentRef = globalThis.document, windowRef = globalThis.window, now = Date.now, minGapMs = 5000 } = {}) {
  let last = -Infinity;
  const go = () => {
    if (hidden(documentRef)) return;
    const t = now();
    if (t - last < minGapMs) return;
    last = t;
    void fn();
  };
  documentRef?.addEventListener?.("visibilitychange", go);
  windowRef?.addEventListener?.("online", go);
  return () => {
    documentRef?.removeEventListener?.("visibilitychange", go);
    windowRef?.removeEventListener?.("online", go);
  };
}

/** When the server answered, from its own Date header (never the device's clock): a number, or null. */
export function checkedAt(response) {
  const raw = response?.headers?.get?.("date");
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

const usable = (a) => Boolean(a) && typeof a === "object" && Number.isFinite(a?.units?.reported) && Number.isFinite(Date.parse(a?.updatedAt));

/**
 * Decides what a page may show after asking for one race's figures.
 *   shown       { results, race } currently on screen (results may be null)
 *   answer      the parsed answer, or null if the request failed or was refused
 *   askedRace   the race the request was for
 *   currentRace the race selected now
 * Returns null when the answer must be ignored because the race changed while it was in flight.
 * Otherwise { results, race, failed }: figures are kept only for the same race, an older answer never replaces a
 * newer one, and figures for one race are never shown under another.
 */
export function pickResults(shown, answer, askedRace, currentRace) {
  if (askedRace !== currentRace) return null;
  const sameRace = shown?.race === askedRace && usable(shown?.results);
  if (usable(answer) && !(sameRace && Date.parse(answer.updatedAt) < Date.parse(shown.results.updatedAt))) return { results: answer, race: askedRace, failed: false };
  return sameRace ? { results: shown.results, race: askedRace, failed: true } : { results: null, race: null, failed: true };
}

/** HH:MM:SS (or HH:MM) in the given time zone, with its label, e.g. "14:03:22 XLT". */
export function clockTime(ms, timeZone, zoneLabel, { seconds = true } = {}) {
  const text = new Date(ms).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
  return `${text} ${zoneLabel}`;
}
