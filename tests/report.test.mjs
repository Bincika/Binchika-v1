import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReport, parseTelegramUpdate, hashReporter } from "../functions/_lib/report.js";

test("valid report normalises party keys", () => {
  const r = parseReport({ channel: "web", handle: "@ada", puCode: "24-09-05-012", race: "president", tally: { apc: 10, lp: "4" } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.tally, { APC: 10, LP: 4 });
});

test("rejects junk: bad channel, bad PU code, negative and huge votes, no evidence", () => {
  const r = parseReport({ channel: "fax", handle: "x", puCode: "24-9-5-12", tally: { APC: -1, PDP: 999999, "A B": 1 } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("channel")));
  assert.ok(r.errors.some((e) => e.includes("puCode")));
  assert.ok(r.errors.some((e) => e.includes("APC")));
  assert.ok(r.errors.some((e) => e.includes("PDP")));
  assert.ok(r.errors.some((e) => e.includes("A B")));
  assert.equal(parseReport({ channel: "web", handle: "x" }).ok, false);
});

test("reporter hash is salted, stable, case-insensitive and refuses a weak salt", async () => {
  const salt = "0123456789abcdef0123";
  assert.equal(await hashReporter(salt, "x", "@Ada"), await hashReporter(salt, "x", " @ada "));
  assert.notEqual(await hashReporter(salt, "x", "@ada"), await hashReporter(salt + "z", "x", "@ada"));
  await assert.rejects(() => hashReporter("short", "x", "@ada"));
});

test("telegram update: largest photo, PU code from caption", () => {
  const u = { message: { chat: { id: 5 }, from: { id: 77 }, caption: "PU 24-09-05-012 Ikeja", photo: [{ file_id: "small" }, { file_id: "big" }] } };
  assert.deepEqual(parseTelegramUpdate(u), { chatId: 5, handle: "tg:77", mediaRef: "tg-file:big", caption: "PU 24-09-05-012 Ikeja", puCode: "24-09-05-012" });
  assert.equal(parseTelegramUpdate({}), null);
});
