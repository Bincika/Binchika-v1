import { test } from "node:test";
import assert from "node:assert/strict";
import { leader, spread } from "../functions/_lib/results.js";

const module = await import("../site/assets/js/lib/results-feed.js").catch(() => ({}));
const factory = (options = {}) => {
  assert.equal(typeof module.createResultsFeed, "function", "shared results-feed factory must exist");
  return module.createResultsFeed({ autoRefresh: false, ...options });
};
const payload = (race = "president", votes = 9) => ({
  race, units: { reported: 1, total: 100 },
  national: { totals: { ALPHA: votes, BRAVO: 3 }, leader: leader({ ALPHA: votes, BRAVO: 3 }) },
  byState: { "XL-LA": { units: 1, totals: { ALPHA: votes, BRAVO: 3 }, leader: leader({ ALPHA: votes, BRAVO: 3 }) } },
  byLga: { "XL-LA": { "24-09": { units: 1, totals: { ALPHA: votes, BRAVO: 3 }, leader: leader({ ALPHA: votes, BRAVO: 3 }) } } },
  spread: { ALPHA: 1, BRAVO: 1 }, updatedAt: "2026-10-30T12:00:00.000Z",
});
const response = (data) => ({ ok: true, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("shared consumers and forced refresh join one in-flight promise", async () => {
  const pending = deferred(); let requests = 0;
  const feed = factory({ fetchImpl: () => { requests++; return pending.promise; } });
  const first = feed.ensure("president");
  const second = feed.ensure("president", { force: true });
  assert.equal(first, second);
  assert.equal(feed.read("president").status, "loading");
  pending.resolve(response(payload()));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(requests, 1);
  assert.equal(a, b);
  assert.equal(a.status, "fresh");
  assert.ok(a.revision);
  assert.equal(feed.read("president").data, a.data);
});

test("a subscriber requesting during loading joins the request already being announced", async () => {
  const pending = deferred(); let requests = 0; let reentrant; let announced = false;
  const feed = factory({ fetchImpl: () => { requests++; return pending.promise; } });
  feed.subscribe((state) => { if (state.status === "loading" && !announced) { announced = true; reentrant = feed.ensure("president", { force: true }); } });
  const first = feed.ensure("president");
  pending.resolve(response(payload()));
  await Promise.all([first, reentrant]);
  assert.equal(first, reentrant);
  assert.equal(requests, 1);
});

test("cache expires within thirty seconds and manual refresh bypasses it", async () => {
  let time = 1_000; let requests = 0;
  const feed = factory({ now: () => time, cacheMs: 90_000, fetchImpl: async () => { requests++; return response(payload()); } });
  const initial = await feed.ensure("president");
  time += 29_999;
  assert.equal((await feed.ensure("president")).revision, initial.revision);
  assert.equal(requests, 1);
  time += 1;
  await feed.ensure("president");
  assert.equal(requests, 2);
  await feed.ensure("president", { force: true });
  assert.equal(requests, 3);
});

test("a failed refresh retains last accepted data and revision", async () => {
  let fail = false; const states = [];
  const feed = factory({ fetchImpl: async () => { if (fail) throw new Error("offline"); return response(payload()); } });
  const unsubscribe = feed.subscribe((state) => states.push(state));
  const initial = await feed.ensure("president"); fail = true;
  const stale = await feed.ensure("president", { force: true });
  assert.equal(stale.status, "stale");
  assert.equal(stale.data, initial.data);
  assert.equal(stale.revision, initial.revision);
  assert.deepEqual(states.map((s) => s.status), ["loading", "fresh", "loading", "stale"]);
  unsubscribe(); const count = states.length;
  await feed.ensure("president", { force: true });
  assert.equal(states.length, count);
});

test("revisiting a stale race retries even when its last success is less than thirty seconds old", async () => {
  let fail=false,requests=0;
  const feed=factory({now:()=>1000,fetchImpl:async()=>{requests++;if(fail)throw Error('offline');return response(payload());}});
  await feed.watch('president');fail=true;
  assert.equal((await feed.ensure('president',{force:true})).status,'stale');
  fail=false;
  assert.equal((await feed.watch('president')).status,'fresh');
  assert.equal(requests,3);
});

test("HTTP, malformed JSON and failed first loads resolve unavailable", async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => { throw new SyntaxError("bad JSON"); } }), async () => { throw new Error("offline"); }]) {
    const state = await factory({ fetchImpl }).ensure("president");
    assert.equal(state.status, "unavailable"); assert.equal(state.data, null); assert.equal(state.revision, null);
  }
});

test("unsupported and unknown races never make requests", async () => {
  let requests = 0;
  const feed = factory({ fetchImpl: async () => { requests++; return response(payload()); } });
  assert.equal((await feed.watch("local-government")).status, "not-connected");
  assert.equal((await feed.ensure("typo")).status, "unavailable");
  assert.equal(requests, 0);
  assert.equal(feed.read("local-government").data, null);
});

test("a slow previous race cannot overwrite the active race", async () => {
  const old = deferred(); const states = [];
  const feed = factory({ fetchImpl: (url) => url.endsWith("president") ? old.promise : Promise.resolve(response(payload("governor"))) });
  feed.subscribe((state) => states.push(state));
  const first = feed.watch("president");
  await feed.watch("governor");
  old.resolve(response(payload())); await first;
  assert.equal(feed.read().race, "governor");
  assert.equal(feed.read().data.race, "governor");
  assert.equal(states.at(-1).race, "president", "subscribers receive race-tagged states for filtering");
});

test("a hanging fetch aborts and resolves unavailable after the deadline", async () => {
  let signal;
  const feed = factory({ timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const state = await feed.ensure("president");
  assert.equal(state.status, "unavailable");
  assert.equal(signal.aborted, true);
});

test("a hanging JSON body is covered by the same deadline", async () => {
  const feed = factory({ timeoutMs: 10, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) });
  assert.equal((await feed.ensure("president")).status, "unavailable");
});

test("late timed-out requests do not replace a newer accepted snapshot", async () => {
  const late = deferred(); let requests = 0;
  const feed = factory({ timeoutMs: 10, fetchImpl: () => ++requests === 1 ? late.promise : Promise.resolve(response(payload("president", 20))) });
  await feed.ensure("president");
  const current = await feed.ensure("president", { force: true });
  late.resolve(response(payload("president", 2))); await Promise.resolve(); await Promise.resolve();
  assert.equal(feed.read("president"), current);
  assert.equal(current.data.national.totals.ALPHA, 20);
});

test("invalid race, timestamps, counts and inconsistent totals fail closed", async () => {
  const changes = [
    (p) => { p.race = "governor"; },
    (p) => { p.updatedAt = "yesterday"; },
    (p) => { p.updatedAt = "2026-02-30T12:00:00.000Z"; },
    (p) => { p.national.totals.ALPHA = -1; },
    (p) => { p.national.totals.ALPHA = 9.5; },
    (p) => { p.byState["XL-LA"].totals.ALPHA = "9"; },
    (p) => { p.byState["XL-LA"].totals.ALPHA = 10; },
    (p) => { p.units.reported = 2; },
    (p) => { p.units.reported = 1.2; },
    (p) => { p.units.total = 0; },
    (p) => { p.byState["XL-LA"].units = 2; },
    (p) => { p.byState["XL-XX"] = p.byState["XL-LA"]; delete p.byState["XL-LA"]; },
    (p) => { p.byLga["XL-LA"]["24-09"].totals.ALPHA = 10; },
    (p) => { p.byLga["XL-LA"]["19-01"] = p.byLga["XL-LA"]["24-09"]; delete p.byLga["XL-LA"]["24-09"]; },
  ];
  for (const change of changes) {
    const bad = payload(); change(bad);
    const state = await factory({ fetchImpl: async () => response(bad) }).ensure("president");
    assert.equal(state.status, "unavailable", change.toString());
    assert.equal(state.data, null);
  }
});

test("zero reporting is valid and a rejected payload retains the good snapshot", async () => {
  let current = { race: "president", units: { reported: 0, total: 100 }, national: { totals: {}, leader: null }, byState: {}, byLga: {}, spread: {}, updatedAt: "2026-10-30T12:00:00.000Z" };
  const feed = factory({ fetchImpl: async () => response(current) });
  const empty = await feed.ensure("president"); assert.equal(empty.status, "fresh");
  current = payload("governor");
  const stale = await feed.ensure("president", { force: true });
  assert.equal(stale.status, "stale"); assert.equal(stale.data, empty.data); assert.equal(stale.revision, empty.revision);
});

test("shared snapshots are immutable across consumers", async () => {
  const state = await factory({ fetchImpl: async () => response(payload()) }).ensure("president");
  assert.throws(() => { state.data.national.totals.ALPHA = 100; }, TypeError);
  assert.throws(() => { state.revision = "different"; }, TypeError);
});

test("a timestamp regression cannot replace the last good revision", async () => {
  let current = payload();
  const feed = factory({ fetchImpl: async () => response(current) });
  const initial = await feed.ensure("president");
  current = { ...payload("president", 99), updatedAt: "2026-10-29T12:00:00.000Z" };
  const stale = await feed.ensure("president", { force: true });
  assert.equal(stale.status, "stale"); assert.equal(stale.data, initial.data); assert.equal(stale.revision, initial.revision);
});

test("demo state races use the same eligible jurisdiction universe as the API", async () => {
  const feed = factory({ demo: true });
  for (const [race, expected] of [["governor", 28], ["state-assembly", 36]]) {
    const state = await feed.ensure(race);
    assert.equal(state.status, "fresh");
    assert.equal(Object.keys(state.data.byState).length, expected, race);
    assert.equal(Object.keys(state.data.byLga).length, expected, race);
    assert.equal(state.data.byState["XL-FC"], undefined, race);
    assert.equal(state.data.units.reported, expected * 6, race);
  }
});

test("demo uses one deterministic reconciled payload with fictional party names", async () => {
  let requests = 0;
  const feed = factory({ demo: true, fetchImpl: async () => { requests++; throw new Error("demo must stay local"); } });
  const first = await feed.watch("president"); const second = await feed.ensure("president", { force: true });
  assert.equal(first.status, "fresh"); assert.equal(first.data, second.data); assert.equal(first.revision, second.revision);
  assert.equal(requests, 0);
  assert.equal(Object.keys(first.data.byState).length, 37);
  assert.deepEqual(Object.keys(first.data.national.totals).sort(), ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT"]);
  assert.deepEqual(first.data, module.createDemoResults("president"));
  const totals = {};
  for (const area of Object.values(first.data.byState)) for (const [party, votes] of Object.entries(area.totals)) totals[party] = (totals[party] ?? 0) + votes;
  assert.deepEqual(first.data.national.totals, totals);
  assert.equal(Object.values(first.data.byState).reduce((sum, area) => sum + area.units, 0), first.data.units.reported);
  assert.deepEqual(first.data.spread, spread(Object.fromEntries(Object.entries(first.data.byState).map(([iso, area]) => [iso, area.totals]))));
  assert.equal((await feed.ensure("local-government")).status, "not-connected");
});

test("auto-refresh watches only the visible active race and refreshes on return", async () => {
  const listeners = new Map(); const timers = new Map(); let nextId = 0; const urls = [];
  const documentRef = { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const feed = factory({ autoRefresh: true, documentRef,
    setTimeoutImpl: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeoutImpl: (id) => timers.delete(id),
    fetchImpl: async (url) => { urls.push(url); return response(payload(new URL(url, "https://example.test").searchParams.get("race"))); },
  });
  assert.equal(timers.size, 0, "construction must not start background timers");
  await feed.watch("president");
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, 30_000);
  await feed.watch("governor");
  assert.equal(timers.size, 1);
  const tick = [...timers.values()][0].fn; timers.clear(); tick();
  await feed.ensure("governor");
  assert.equal(urls.at(-1), "/api/results?race=governor");
  documentRef.visibilityState = "hidden"; listeners.get("visibilitychange")(); assert.equal(timers.size, 0);
  const count = urls.length;
  documentRef.visibilityState = "visible"; listeners.get("visibilitychange")(); await feed.ensure("governor");
  assert.equal(urls.length, count + 1);
  await feed.watch("local-government"); assert.equal(timers.size, 0);
  feed.destroy(); assert.equal(listeners.size, 0); assert.equal(timers.size, 0);
});

// Session 107: a poll that brings the same counts must not look like a change.
const later = (data, seconds) => ({ ...data, updatedAt: new Date(Date.parse(data.updatedAt) + seconds * 1000).toISOString() });

test("content revision holds when only the timestamp changes, and moves when counts change", async () => {
  let body = payload("president", 9);
  const feed = factory({ fetchImpl: async () => response(body) });
  const first = await feed.ensure("president", { force: true });
  assert.match(first.contentRevision, /^president:c\d+$/);
  assert.equal(first.changedAt, null); assert.equal(first.delta, null);
  body = later(body, 30);
  const same = await feed.ensure("president", { force: true });
  assert.notEqual(same.revision, first.revision, "each accepted fetch still has its own revision");
  assert.equal(same.contentRevision, first.contentRevision);
  assert.equal(same.changedAt, null);
  body = later(payload("president", 12), 60);
  const moved = await feed.ensure("president", { force: true });
  assert.notEqual(moved.contentRevision, first.contentRevision);
  assert.ok(Number.isFinite(moved.changedAt));
});

test("a content revision belongs to one race, so identical empty races never match", async () => {
  const empty = (race) => ({ race, units: { reported: 0, total: 100 }, national: { totals: {} }, byState: {}, byLga: {}, spread: {}, updatedAt: "2026-10-30T12:00:00.000Z" });
  const feed = factory({ fetchImpl: async (url) => response(empty(new URL(url, "https://example.test").searchParams.get("race"))) });
  const a = await feed.ensure("president"); const b = await feed.ensure("senate");
  assert.notEqual(a.contentRevision, b.contentRevision);
  assert.equal(factory().read("house").contentRevision, null);
});

test("a change reports the delta in polling units and votes against the previous snapshot", async () => {
  let body = payload("president", 9);
  const feed = factory({ fetchImpl: async () => response(body) });
  await feed.ensure("president", { force: true });
  body = later(payload("president", 15), 30);
  assert.deepEqual((await feed.ensure("president", { force: true })).delta, { units: 0, votes: 6 });
  body = later(payload("president", 10), 60);
  assert.deepEqual((await feed.ensure("president", { force: true })).delta, { units: 0, votes: -5 });
});

test("a rejected or failed refresh keeps the content revision and delta", async () => {
  let body = payload("president", 9), fail = false;
  const feed = factory({ fetchImpl: async () => { if (fail) throw new Error("down"); return response(body); } });
  await feed.ensure("president", { force: true });
  body = later(payload("president", 15), 30);
  const good = await feed.ensure("president", { force: true });
  fail = true;
  const failed = await feed.ensure("president", { force: true });
  assert.equal(failed.status, "stale");
  assert.equal(failed.contentRevision, good.contentRevision); assert.deepEqual(failed.delta, good.delta);
  fail = false; body = later(payload("president", 99), -999);
  const rejected = await feed.ensure("president", { force: true });
  assert.equal(rejected.status, "stale"); assert.equal(rejected.contentRevision, good.contentRevision);
});

const liveFeed = (fetchImpl) => {
  const listeners = new Map(), timers = new Map(); let nextId = 0;
  const documentRef = { visibilityState: "visible", addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const feed = factory({ autoRefresh: true, documentRef, fetchImpl,
    setTimeoutImpl: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeoutImpl: (id) => timers.delete(id) });
  return { feed, timers, listeners, documentRef, delays: () => [...timers.values()].map((t) => t.delay).filter((d) => d !== 12_000) };
};

test("pause stops scheduled and visibility refreshes; manual refresh still works; resume refreshes once and restarts the timer", async () => {
  let requests = 0;
  const { feed, delays, listeners, documentRef } = liveFeed(async (url) => { requests++; return response(payload(new URL(url, "https://example.test").searchParams.get("race"))); });
  await feed.watch("president");
  assert.equal(feed.isPaused(), false); assert.equal(delays().length, 1);
  feed.setPaused(true);
  assert.equal(feed.isPaused(), true); assert.equal(delays().length, 0);
  const before = requests;
  documentRef.visibilityState = "hidden"; listeners.get("visibilitychange")();
  documentRef.visibilityState = "visible"; listeners.get("visibilitychange")();
  await Promise.resolve();
  assert.equal(requests, before, "returning to the page must not refresh while paused");
  await feed.ensure("president", { force: true });
  assert.equal(requests, before + 1, "Refresh now still fetches");
  assert.equal(delays().length, 0, "a manual refresh does not restart the timer");
  await feed.watch("senate");
  assert.equal(requests, before + 2, "a race with no data still loads once");
  assert.equal(delays().length, 0);
  feed.setPaused(false);
  await feed.ensure("senate");
  assert.equal(requests, before + 3, "resume refreshes once");
  assert.equal(delays().length, 1);
  feed.destroy();
});

test("failed refreshes back off to 240 s and a success returns to 30 s", async () => {
  let fail = false, stamp = 0;
  const { feed, delays } = liveFeed(async () => { if (fail) throw new Error("down"); return response(later(payload(), stamp++)); });
  await feed.watch("president");
  assert.deepEqual(delays(), [30_000]);
  fail = true;
  const seen = [];
  for (let i = 0; i < 5; i++) { await feed.ensure("president", { force: true }); seen.push(delays()[0]); }
  assert.deepEqual(seen, [60_000, 120_000, 240_000, 240_000, 240_000]);
  fail = false;
  await feed.ensure("president", { force: true });
  assert.deepEqual(delays(), [30_000]);
  feed.destroy();
});

test("preload loads a likely next race once, and never the active race, while paused or after a recent attempt", async () => {
  const urls = []; let fail = false, clock = 1_000_000;
  const feed = factory({ now: () => clock, fetchImpl: async (url) => { urls.push(url); if (fail) throw new Error("down"); return response(payload(new URL(url, "https://example.test").searchParams.get("race"))); } });
  await feed.watch("president");
  urls.length = 0;
  await feed.preload("president");
  assert.equal(urls.length, 0, "active race");
  await feed.preload("local-government");
  assert.equal(urls.length, 0, "no feed");
  await feed.preload("senate");
  assert.equal(urls.length, 1); assert.equal(feed.read("senate").status, "fresh");
  await feed.preload("senate");
  assert.equal(urls.length, 1, "still recent");
  feed.setPaused(true); clock += 60_000;
  await feed.preload("senate");
  assert.equal(urls.length, 1, "paused");
  feed.setPaused(false); await feed.ensure("president");
  urls.length = 0; fail = true;
  await feed.preload("house"); await feed.preload("house");
  assert.equal(urls.length, 1, "a failed preload is not retried on every hover");
});

test("a failed preload of another race cannot slow the active race", async () => {
  let fail = false;
  const { feed, delays } = liveFeed(async () => { if (fail) throw new Error("down"); return response(payload()); });
  await feed.watch("president");
  fail = true;
  await feed.preload("senate");
  assert.deepEqual(delays(), [30_000]);
  feed.destroy();
});
