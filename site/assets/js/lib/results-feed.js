// One accepted snapshot per race, shared by the dashboard and ledger. No UI side effects.
import { STATE_CODE, aggregate, aggregateByLga, eligibleStateForRace, leader, spread } from "./results.js";

const RACES = new Set(["president", "senate", "house", "governor", "state-assembly"]);
const STATES = new Set(Object.values(STATE_CODE));
const PARTIES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"];
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const requireValid = (condition) => { if (!condition) throw new Error("Invalid citizen tally payload"); };

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= new Date(Date.UTC(+year, +month, 0)).getUTCDate()
    && +hour <= 23 && +minute <= 59 && +second <= 59
    && (zone === "Z" || (+zone.slice(1, 3) <= 23 && +zone.slice(4) <= 59));
}

function validateTotals(totals) {
  requireValid(isObject(totals));
  let sum = 0;
  for (const [party, votes] of Object.entries(totals)) {
    requireValid(/^[A-Z][A-Z0-9-]{0,31}$/.test(party) && count(votes));
    sum += votes;
    requireValid(count(sum));
  }
  return sum;
}

function addTotals(sum, totals) {
  for (const [party, votes] of Object.entries(totals)) {
    sum[party] = (sum[party] ?? 0) + votes;
    requireValid(count(sum[party]));
  }
}

function sameTotals(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((party) => (a[party] ?? 0) === (b[party] ?? 0));
}

function validateArea(area) {
  requireValid(isObject(area) && count(area.units));
  const votes = validateTotals(area.totals);
  requireValid(area.units > 0 || votes === 0);
}

function deepFreeze(value) {
  if (isObject(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validatePayload(data, race) {
  requireValid(isObject(data) && data.race === race && validTimestamp(data.updatedAt));
  requireValid(isObject(data.units) && count(data.units.reported) && count(data.units.total) && data.units.total > 0 && data.units.reported <= data.units.total);
  requireValid(isObject(data.national) && isObject(data.byState));
  validateTotals(data.national.totals);
  let units = 0;
  const totals = {};
  for (const [iso, area] of Object.entries(data.byState)) {
    requireValid(STATES.has(iso));
    validateArea(area);
    units += area.units;
    requireValid(count(units));
    addTotals(totals, area.totals);
  }
  requireValid(units === data.units.reported && sameTotals(totals, data.national.totals));
  if (data.byLga !== undefined) {
    requireValid(isObject(data.byLga));
    for (const [iso, areas] of Object.entries(data.byLga)) {
      requireValid(STATES.has(iso) && isObject(areas) && Object.hasOwn(data.byState, iso));
      let areaUnits = 0;
      const areaTotals = {};
      for (const [code, area] of Object.entries(areas)) {
        requireValid(/^\d{2}-\d{2}$/.test(code) && STATE_CODE[code.slice(0, 2)] === iso);
        validateArea(area);
        areaUnits += area.units;
        requireValid(count(areaUnits));
        addTotals(areaTotals, area.totals);
      }
      requireValid(areaUnits === data.byState[iso].units && sameTotals(areaTotals, data.byState[iso].totals));
    }
    for (const [iso, area] of Object.entries(data.byState)) requireValid(area.units === 0 || Object.hasOwn(data.byLga, iso));
  }
  // Derive display summaries from the validated counts so all consumers use the same arithmetic.
  const byState = Object.fromEntries(Object.entries(data.byState).map(([iso, area]) => [iso, { ...area, leader: leader(area.totals) }]));
  const byLga = data.byLga === undefined ? undefined : Object.fromEntries(Object.entries(data.byLga).map(([iso, areas]) => [iso,
    Object.fromEntries(Object.entries(areas).map(([code, area]) => [code, { ...area, leader: leader(area.totals) }]))]));
  return deepFreeze({ ...data, national: { ...data.national, leader: leader(data.national.totals) }, byState,
    ...(byLga === undefined ? {} : { byLga }), spread: spread(Object.fromEntries(Object.entries(byState).map(([iso, area]) => [iso, area.totals]))) });
}

// Reported counts only: updatedAt moves on every response, so it must not count as a change.
const sortedTotals = (totals) => Object.entries(totals).sort(([a], [b]) => a.localeCompare(b));
const sortedAreas = (areas) => Object.keys(areas).sort().map((key) => [key, areas[key].units, sortedTotals(areas[key].totals)]);
const contentKey = (data) => JSON.stringify([data.units.reported, data.units.total, sortedTotals(data.national.totals), sortedAreas(data.byState),
  Object.keys(data.byLga ?? {}).sort().map((iso) => [iso, sortedAreas(data.byLga[iso])])]);
const voteSum = (data) => Object.values(data.national.totals).reduce((sum, votes) => sum + votes, 0);

/** Deterministic fictional counts; jurisdiction codes support the map, no real place names occur. */
export function createDemoResults(race = "president") {
  if (!RACES.has(race)) return null;
  const raceOffset = [...RACES].indexOf(race);
  const rows = [];
  for (const code of Object.keys(STATE_CODE).filter((code) => eligibleStateForRace(race, STATE_CODE[code]))) for (let lga = 1; lga <= 3; lga++) for (let unit = 1; unit <= 2; unit++) {
    const seed = Number(code) * 17 + lga * 11 + unit * 7 + raceOffset * 13;
    rows.push({ pu_code: `${code}-${String(lga).padStart(2, "0")}-01-${String(unit).padStart(3, "0")}`,
      tally: Object.fromEntries(PARTIES.map((party, index) => [party, 15 + ((seed * (index + 3) + index * 31) % 120)])) });
  }
  const summed = aggregate(rows);
  return validatePayload({ race, demo: true, notice: "Demonstration only: fictional parties and polling units.",
    units: { reported: summed.units, total: 37000, totalSource: "Fictional demonstration units" },
    national: { totals: summed.national, leader: leader(summed.national) }, byState: summed.byState, byLga: aggregateByLga(rows),
    spread: {}, updatedAt: "2027-02-20T12:00:00.000Z" }, race);
}

/** Options: fetchImpl, now, demo; cacheMs (max 30s), timeoutMs (default 12s);
 * autoRefresh (browser default true), documentRef and timer functions allow isolated tests.
 * ensure/watch resolve state, read defaults to the watched race, subscribe emits changed race-tagged states.
 * State also carries contentRevision (moves only when reported counts change; includes the race), changedAt and delta.
 * setPaused stops automatic refreshes for every consumer; a user action can still fetch. preload is for likely next races.
 * destroy stops visibility polling. Construction/import starts no timers or requests. */
export function createResultsFeed(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const now = options.now ?? Date.now;
  const documentRef = options.documentRef ?? globalThis.document;
  const autoRefresh = options.autoRefresh ?? Boolean(documentRef);
  const setTimer = options.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.min(30_000, Math.max(0, options.cacheMs)) : 30_000;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 12_000;
  const entries = new Map();
  const listeners = new Set();
  let activeRace = null;
  let nextRevision = 0;
  let refreshTimer = null;
  let listening = false;
  let destroyed = false;
  let paused = false;
  const visible = () => !documentRef || (documentRef.visibilityState !== "hidden" && documentRef.hidden !== true);
  const entryFor = (race) => {
    if (!entries.has(race)) entries.set(race, { state: Object.freeze({ race, data: null, status: race === "local-government" ? "not-connected" : "unavailable", revision: null, contentRevision: null, changedAt: null, delta: null }), fetchedAt: null, promise: null, attemptedAt: null, failures: 0, contentKey: null, contentCount: 0 });
    return entries.get(race);
  };
  const publish = (entry, status, data = entry.state.data, revision = entry.state.revision, content = entry.state) => {
    entry.state = Object.freeze({ race: entry.state.race, data, status, revision, contentRevision: content.contentRevision, changedAt: content.changedAt, delta: content.delta });
    for (const listener of listeners) { try { listener(entry.state); } catch { /* A consumer must not break the shared request. */ } }
    return entry.state;
  };
  const accepted = (entry, data) => {
    const key = contentKey(data), prior = entry.state.data;
    if (key === entry.contentKey) return entry.state;
    entry.contentKey = key;
    return Object.freeze({ contentRevision: `${entry.state.race}:c${++entry.contentCount}`, changedAt: prior ? now() : null, delta: prior ? Object.freeze({ units: data.units.reported - prior.units.reported, votes: voteSum(data) - voteSum(prior) }) : null });
  };
  const stopTimer = () => { if (refreshTimer !== null) clearTimer(refreshTimer); refreshTimer = null; };
  const schedule = () => {
    stopTimer();
    if (destroyed || paused || !autoRefresh || !documentRef || !visible() || !RACES.has(activeRace) || options.demo) return;
    // Failures space out the retries so a struggling ledger is not hit harder: 60 s, 120 s, then 240 s.
    const delay = 30_000 * 2 ** Math.min(entryFor(activeRace).failures, 3);
    refreshTimer = setTimer(() => { refreshTimer = null; void ensure(activeRace, { force: true }); }, delay);
  };

  function ensure(race = activeRace, { force = false } = {}) {
    const entry = entryFor(race);
    if (!RACES.has(race) || destroyed) return Promise.resolve(entry.state);
    if (entry.promise) return entry.promise;
    if (entry.state.status === 'fresh' && entry.state.data && (options.demo || (!force && entry.fetchedAt !== null && now() - entry.fetchedAt < cacheMs))) return Promise.resolve(entry.state);
    if (race === activeRace) stopTimer();
    entry.attemptedAt = now();
    // Start on a microtask after assigning the promise, including for synchronous test fetches.
    entry.promise = Promise.resolve().then(async () => {
      let timeout;
      const controller = new AbortController();
      try {
        let data;
        if (options.demo) data = createDemoResults(race);
        else {
          const deadline = new Promise((_, reject) => { timeout = setTimer(() => { controller.abort(); reject(new Error("Citizen tally request timed out")); }, timeoutMs); });
          const request = Promise.resolve().then(async () => {
            const result = await fetchImpl(`/api/results?race=${encodeURIComponent(race)}`, { signal: controller.signal, headers: { accept: "application/json" } });
            requireValid(result?.ok === true && typeof result.json === "function");
            return validatePayload(await result.json(), race);
          });
          data = await Promise.race([request, deadline]);
        }
        requireValid(!entry.state.data || Date.parse(data.updatedAt) >= Date.parse(entry.state.data.updatedAt));
        entry.fetchedAt = now();
        entry.failures = 0;
        return publish(entry, "fresh", data, `${race}:${++nextRevision}`, accepted(entry, data));
      } catch {
        entry.failures++;
        return publish(entry, entry.state.data ? "stale" : "unavailable");
      } finally {
        if (timeout !== undefined) clearTimer(timeout);
        entry.promise = null;
        if (race === activeRace) schedule();
      }
    });
    publish(entry, "loading");
    return entry.promise;
  }

  const onVisibility = () => {
    stopTimer();
    if (!paused && visible() && RACES.has(activeRace)) void ensure(activeRace, { force: true });
  };
  return Object.freeze({
    ensure,
    setPaused: (value) => {
      paused = Boolean(value);
      if (paused) stopTimer();
      else if (RACES.has(activeRace)) void ensure(activeRace, { force: true });
    },
    isPaused: () => paused,
    preload: (race) => {
      const entry = entryFor(race);
      if (paused || race === activeRace || !RACES.has(race) || (entry.attemptedAt !== null && now() - entry.attemptedAt < cacheMs)) return Promise.resolve(entry.state);
      return ensure(race);
    },
    read: (race = activeRace) => entryFor(race).state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    watch: (race) => {
      activeRace = race;
      if (autoRefresh && documentRef && !listening && !destroyed) { documentRef.addEventListener("visibilitychange", onVisibility); listening = true; }
      schedule();
      return ensure(race);
    },
    destroy: () => {
      destroyed = true; stopTimer(); listeners.clear();
      if (listening) documentRef.removeEventListener("visibilitychange", onVisibility);
      listening = false;
    },
  });
}

export const resultsFeed = createResultsFeed({ demo: new URLSearchParams(globalThis.location?.search ?? "").get("demo") === "1" });
