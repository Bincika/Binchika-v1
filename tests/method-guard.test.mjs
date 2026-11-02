import { test } from "node:test";
import assert from "node:assert/strict";
import * as ocr from "../functions/api/pipeline/ocr.js";
import * as official from "../functions/api/pipeline/official.js";
import * as review from "../functions/api/portal/review.js";
import * as decide from "../functions/api/admin/decide.js";

// Session 90: GET on a write route answers 405 with "Allow: POST" instead of falling through to the home page (the soft
// 404). The handler reads nothing: no request, no environment, no database.
test("write routes answer GET with 405 and Allow: POST, and keep their POST handler", async () => {
  for (const [name, mod] of Object.entries({ ocr, official, review, decide })) {
    assert.equal(typeof mod.onRequestPost, "function", `${name} still has POST`);
    const r = mod.onRequestGet();
    assert.equal(r.status, 405, name);
    assert.equal(r.headers.get("allow"), "POST", name);
    assert.equal(r.headers.get("cache-control"), "no-store", name);
    assert.deepEqual(await r.json(), { error: "method not allowed", allow: "POST" }, name);
  }
});
