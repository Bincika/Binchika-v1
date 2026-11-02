import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, electionOnly, mergeLatest } from "../functions/_lib/rss.js";

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[INEC releases 2027 timetable &amp; guidelines]]></title><link>https://a.ng/1?utm=x</link><pubDate>Fri, 23 Oct 2026 10:00:00 +0100</pubDate></item>
<item><title>Super Eagles win friendly</title><link>https://a.ng/2</link><pubDate>Fri, 23 Oct 2026 11:00:00 +0100</pubDate></item>
<item><title>No link here</title></item>
</channel></rss>`;
const atom = `<feed><entry><title>Governorship candidates sign peace accord</title><link href="https://b.ng/x"/><updated>2026-10-24T08:00:00Z</updated></entry></feed>`;

test("parses RSS and Atom, decodes entities, skips items without links", () => {
  const a = parseFeed(rss, "A");
  assert.equal(a.length, 2);
  assert.equal(a[0].title, "INEC releases 2027 timetable & guidelines");
  assert.equal(a[0].publishedAt, "2026-10-23T09:00:00.000Z");
  assert.deepEqual(parseFeed(atom, "B")[0].link, "https://b.ng/x");
});

test("election filter keeps only election coverage", () => {
  assert.deepEqual(electionOnly(parseFeed(rss, "A")).map((i) => i.link), ["https://a.ng/1?utm=x"]);
});

test("merge de-duplicates by URL (ignoring query) and sorts newest first", () => {
  const a = parseFeed(rss, "A");
  const dup = [{ ...a[0], link: "https://a.ng/1?utm=y", source: "C" }];
  const out = mergeLatest([electionOnly(a), parseFeed(atom, "B"), dup]);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, "B");
});

test("round-robin: one prolific outlet cannot fill the reel", () => {
  const mk = (src, n) => Array.from({ length: n }, (_, i) => ({ title: `INEC ${src}${i}`, link: `https://${src}.ng/${i}`, source: src, publishedAt: new Date(Date.UTC(2026, 9, 24, 12, 0 - i)).toISOString() }));
  const out = mergeLatest([mk("a", 10), mk("b", 2)], 4);
  assert.deepEqual(out.map((i) => i.source), ["a", "b", "a", "b"]);
});
