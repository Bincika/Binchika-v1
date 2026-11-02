import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { sniff, stripJpeg, stripPng, stripWebp, stripMp4, exifOrientation, processEvidence, checkPeople, sha256Hex, PipelineError } from "../functions/_lib/photo.js";
import { evidenceMedia, mediaKeyOf } from "../functions/_lib/evidence.js";
import { onRequestPost as postMedia } from "../functions/api/pipeline/media.js";

const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => { const a = parts.map((p) => (typeof p === "string" ? enc(p) : p instanceof Uint8Array ? p : new Uint8Array(p))); const o = new Uint8Array(a.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of a) { o.set(p, i); i += p.length; } return o; };
const has = (bytes, s) => Buffer.from(bytes).includes(Buffer.from(s, "latin1"));
const seg = (marker, data) => cat([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255], data);

// A JPEG with everything a phone might add: EXIF (camera, GPS, orientation 6), XMP, MPF, IPTC, a comment, a colour
// profile, and a "motion photo" video appended after the end of the image.
function exifTiff(orientation) {
  const t = new Uint8Array(96), v = new DataView(t.buffer);
  t.set(enc("II*\0")); v.setUint32(4, 8, true); v.setUint16(8, 3, true);
  const entry = (k, tag, type, count, value) => { const e = 10 + k * 12; v.setUint16(e, tag, true); v.setUint16(e + 2, type, true); v.setUint32(e + 4, count, true); v.setUint32(e + 8, value, true); };
  entry(0, 0x010f, 2, 9, 60); entry(1, 0x0112, 3, 1, orientation); entry(2, 0x8825, 4, 1, 72);
  t.set(enc("CANONEOS\0"), 60); t.set(enc("GPSLAT51.5N"), 72);
  return cat("Exif\0\0", t);
}
const SCAN = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a];
function phoneJpeg(orientation = 6) {
  return cat([0xff, 0xd8], seg(0xe0, cat("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0])), seg(0xe1, exifTiff(orientation)),
    seg(0xe1, cat("http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta>GPSXMP</x:xmpmeta>")), seg(0xe2, cat("ICC_PROFILE\0", [1, 1], "ICCDATA")),
    seg(0xe2, cat("MPF\0", "MPFJUNK")), seg(0xed, cat("Photoshop 3.0\0", "IPTCBYLINE")), seg(0xfe, enc("secret comment")),
    seg(0xdb, [0, 1, 2]), seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), seg(0xda, [1, 1, 0, 0, 63, 0]), SCAN, [0xff, 0xd9], "MOTIONVIDEO");
}

test("sniff: the content decides the type, not the name", () => {
  assert.equal(sniff(phoneJpeg()), "image/jpeg");
  assert.equal(sniff(cat([137, 80, 78, 71, 13, 10, 26, 10], [0, 0, 0, 0])), "image/png");
  assert.equal(sniff(cat("RIFF", [4, 0, 0, 0], "WEBPVP8 ")), "image/webp");
  assert.equal(sniff(cat([0, 0, 0, 16], "ftypisom", [0, 0, 0, 0])), "video/mp4");
  assert.equal(sniff(cat([0, 0, 0, 24], "ftypheic", [0, 0, 0, 0])), "image/heic", "HEIC shares the box format but is not MP4");
  assert.equal(sniff(cat([0, 0, 0, 24], "ftypavif", [0, 0, 0, 0])), "image/heic");
  assert.equal(sniff(enc("GIF89a....")), null);
});

test("JPEG: camera, location, XMP, IPTC, comments and appended video are removed; image data, colour profile and orientation kept", () => {
  const src = phoneJpeg(6);
  assert.equal(exifOrientation(exifTiff(6)), 6);
  const r = stripJpeg(src);
  for (const s of ["CANONEOS", "GPSLAT", "GPSXMP", "MPFJUNK", "IPTCBYLINE", "secret comment", "MOTIONVIDEO"]) assert.equal(has(r.bytes, s), false, s);
  assert.ok(has(r.bytes, "ICCDATA") && has(r.bytes, "JFIF"), "colour profile and JFIF kept");
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, ...SCAN, 0xff, 0xd9])), "scan data copied byte for byte, ending at EOI");
  assert.equal(r.orientation, 6);
  assert.equal(exifOrientation(r.bytes.subarray(6, 6 + 32)), 6, "a minimal EXIF with only the orientation is written back");
  assert.deepEqual([...r.bytes.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...r.bytes.subarray(-2)], [0xff, 0xd9]);
  assert.deepEqual(r.removed.sort(), ["APP2", "EXIF (camera, location, time)", "IPTC", "XMP", "comment", "data after the end of the image"].sort());
  const upright = stripJpeg(phoneJpeg(1));
  assert.equal(has(upright.bytes, "Exif"), false, "no EXIF at all when the photo is already upright");
});

test("JPEG: progressive files with several scans survive; damaged files are refused", () => {
  const prog = cat([0xff, 0xd8], seg(0xc2, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), seg(0xda, [1, 1, 0, 0, 0, 0]), [1, 2, 0xff, 0x00, 3],
    seg(0xc4, [0, 1, 2]), seg(0xda, [1, 1, 0, 1, 63, 0]), [4, 5, 6], [0xff, 0xd9]);
  const r = stripJpeg(prog);
  assert.deepEqual([...r.bytes], [...prog], "nothing to remove: unchanged");
  assert.throws(() => stripJpeg(prog.subarray(0, prog.length - 2)), PipelineError, "no end-of-image");
  assert.throws(() => stripJpeg(cat([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), PipelineError, "bad segment length");
  assert.throws(() => stripJpeg(enc("not a jpeg")), PipelineError);
});

const chunk = (type, data) => { const body = cat(type, data); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body) >>> 0); return cat([data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255], body, c); };
test("PNG: text, EXIF, time and unknown chunks and trailing data are removed; image chunks copied exactly", () => {
  const ihdr = chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), idat = chunk("IDAT", [120, 1, 2, 3]), iend = chunk("IEND", []), srgb = chunk("sRGB", [0]);
  const src = cat([137, 80, 78, 71, 13, 10, 26, 10], ihdr, srgb, chunk("tEXt", enc("Author\0Jane Doe")), chunk("eXIf", enc("GPSPNG")), chunk("tIME", [7, 234, 10, 29, 9, 0, 0]),
    chunk("iTXt", enc("Comment\0\0\0\0\0hello")), chunk("prVt", enc("vendor")), idat, iend, "XTRA");
  const r = stripPng(src);
  assert.deepEqual([...r.bytes], [...cat([137, 80, 78, 71, 13, 10, 26, 10], ihdr, srgb, idat, iend)]);
  assert.deepEqual(r.removed.sort(), ["EXIF (camera, location, time)", "chunk prVt", "data after the end of the image", "text (author, software, comments)", "time"].sort());
  assert.throws(() => stripPng(src.subarray(0, 40)), PipelineError);
});

const riff = (type, data) => { const n = data.length; return cat(type, [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24], data, n & 1 ? [0] : []); };
test("WebP: EXIF and XMP chunks removed, their VP8X flags cleared and the RIFF size corrected", () => {
  const vp8x = riff("VP8X", [0x10 | 0x08 | 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0]), vp8l = riff("VP8L", [1, 2, 3, 4, 5]);
  const body = cat("WEBP", vp8x, vp8l, riff("EXIF", enc("GPSWEBP!")), riff("XMP ", enc("<xmp/>")));
  const src = cat("RIFF", [body.length & 255, body.length >> 8, 0, 0], body);
  const r = stripWebp(src);
  assert.equal(has(r.bytes, "GPSWEBP") || has(r.bytes, "<xmp/>"), false);
  assert.equal(r.bytes[20], 0x10, "only the alpha flag remains");
  assert.equal(new DataView(r.bytes.buffer).getUint32(4, true), r.bytes.length - 8);
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from(vp8l)), "image chunk (odd length, padded) copied exactly");
});

const box = (type, ...payload) => { const p = cat(...payload); const n = p.length + 8; return cat([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255], type, p); };
test("MP4: location, camera and vendor metadata blanked in place; sizes and media data unchanged", () => {
  const mdat = box("mdat", "FRAMEDATA-0123456789");
  const src = cat(box("ftyp", "isom", [0, 0, 2, 0], "isomiso2mp41"),
    box("moov", box("mvhd", new Uint8Array(100)), box("udta", box("©xyz", "+51.5074-000.1278/"), box("©mak", "Apple")),
      box("trak", box("tkhd", new Uint8Array(84)), box("udta", box("©mod", "iPhone 15 Pro")), box("mdia", box("mdhd", new Uint8Array(24)))),
      box("meta", new Uint8Array(4), box("hdlr", "mdta"), box("keys", "com.apple.quicktime.location.ISO6709"))),
    box("uuid", "XMPUUIDXMPUUID00", "<x:xmpmeta/>"), mdat);
  const r = stripMp4(src);
  assert.equal(r.bytes.length, src.length, "same length: every offset stays valid");
  for (const s of ["+51.5074", "Apple", "iPhone", "com.apple.quicktime.location", "xmpmeta"]) assert.equal(has(r.bytes, s), false, s);
  assert.ok(has(r.bytes, "free") && has(r.bytes, "moov") && has(r.bytes, "mvhd") && has(r.bytes, "tkhd"));
  assert.ok(Buffer.from(r.bytes).includes(Buffer.from(mdat)), "media data untouched");
  assert.equal(has(src, "+51.5074"), true, "the original buffer is not modified");
  assert.throws(() => stripMp4(cat(box("ftyp", "isom"), [0, 0, 0, 99], "moov")), PipelineError, "bad box size");
});

// ---------- end to end: report → processed file in R2 → evidence viewer ----------
function sqliteD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0001_init.sql", "0002_ledger.sql", "0005_evidence.sql", "0006_media.sql"]) db.exec(readFileSync(new URL(`../db/d1/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => db.prepare(sql).get(...args) ?? null, all: async () => ({ results: db.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: db.prepare(sql).run(...args).changes } }) });
  return { db, prepare: (sql) => stmt(sql) };
}
function bucket() {
  const store = new Map();
  return { store, put: async (k, v, o) => store.set(k, { body: v, size: v.length, httpMetadata: o?.httpMetadata, customMetadata: o?.customMetadata }), get: async (k) => store.get(k) ?? null, delete: async (k) => store.delete(k) };
}
async function setup(sha = null) {
  const D1 = sqliteD1();
  D1.db.prepare("INSERT INTO reports (id, channel, reporter_hash, pu_code, race, media_ref, media_sha256, status, evidence, audit_status) VALUES ('rep-1', 'web', 'h', '24-09-05-012', 'president', 'tg-file:X', ?, 'needs_review', 'board', 'pending')").run(sha);
  return { D1, EVIDENCE: bucket() };
}

test("pipeline: stores the cleaned file under full/ with its fingerprint, and the evidence viewer can open it", async () => {
  const src = phoneJpeg(6);
  const { D1, EVIDENCE } = await setup(await sha256Hex(src));
  const AI = { run: async (model, input) => (assert.ok(Array.isArray(input.image)), [{ label: "person", score: 0.93 }]) };
  const r = await processEvidence({ DB: D1, EVIDENCE, AI }, { reportId: "rep-1", bytes: src, contentType: "image/jpeg" });
  assert.equal(r.status, 200);
  assert.equal(r.body.mediaRef, "r2:full/2027/24-09-05-012/rep-1.jpg");
  assert.equal(r.body.people, "detected");
  const stored = EVIDENCE.store.get("full/2027/24-09-05-012/rep-1.jpg");
  assert.equal(has(stored.body, "GPSLAT") || has(stored.body, "CANONEOS"), false, "only the cleaned file is stored");
  assert.equal(stored.httpMetadata.contentType, "image/jpeg");
  const row = D1.db.prepare("SELECT media_ref, media_sha256, original_sha256, face_check, media_removed, media_processed_at FROM reports WHERE id = 'rep-1'").get();
  assert.equal(row.media_sha256, await sha256Hex(stored.body), "fingerprint is of the stored file");
  assert.equal(row.original_sha256, await sha256Hex(src));
  assert.equal(row.face_check, "detected");
  assert.ok(JSON.parse(row.media_removed).includes("EXIF (camera, location, time)") && row.media_processed_at);
  assert.equal(mediaKeyOf(row.media_ref), "full/2027/24-09-05-012/rep-1.jpg");
  const view = await evidenceMedia(D1, EVIDENCE, "rep-1", { role: "szv", public_id: "V0007", states: ["NG-LA"], aal: "aal2" });
  assert.equal(view.status, 200);
  assert.equal(await sha256Hex(view.object.body), row.media_sha256, "the viewer serves exactly the stored, fingerprinted file");
  assert.equal(view.report.face_check, "detected");
  assert.equal((await processEvidence({ DB: D1, EVIDENCE, AI }, { reportId: "rep-1", bytes: src, contentType: "image/jpeg" })).status, 409, "processed once");
});

test("pipeline: people check is 'unchecked' without a detector, for video, or on error; 'none' only when the detector finds no person", async () => {
  const img = stripJpeg(phoneJpeg()).bytes;
  assert.equal(await checkPeople({}, img, "image/jpeg"), "unchecked");
  assert.equal(await checkPeople({ AI: { run: async () => [{ label: "person", score: 0.9 }] } }, img, "video/mp4"), "unchecked");
  assert.equal(await checkPeople({ AI: { run: async () => { throw new Error("quota"); } } }, img, "image/jpeg"), "unchecked");
  assert.equal(await checkPeople({ AI: { run: async () => [{ label: "car", score: 0.99 }, { label: "person", score: 0.3 }] } }, img, "image/jpeg"), "none");
  assert.equal(await checkPeople({ AI: { run: async () => ({ result: [{ label: "person", score: 0.7 }] }) } }, img, "image/jpeg"), "detected");
});

test("pipeline: refuses the wrong type, a disguised file, a changed file, a damaged file and unknown reports", async () => {
  const src = phoneJpeg();
  const { D1, EVIDENCE } = await setup(await sha256Hex(src));
  const run = (o) => processEvidence({ DB: D1, EVIDENCE }, { reportId: "rep-1", bytes: src, contentType: "image/jpeg", ...o });
  assert.equal((await run({ contentType: "image/heic" })).status, 415);
  assert.match((await run({ contentType: "image/heic" })).body.error, /convert HEIC/);
  assert.equal((await run({ contentType: "image/png" })).status, 415, "declared PNG but the bytes are JPEG");
  assert.equal((await run({ contentType: "video/mp4", bytes: cat([0, 0, 0, 24], "ftypheic", new Uint8Array(40)) })).status, 415, "a HEIC photo declared as MP4 is refused");
  assert.equal((await run({ bytes: cat(src, [0]) })).status, 422, "does not match the fingerprint sent with the report");
  assert.equal((await run({ reportId: "nope" })).status, 404);
  const broken = phoneJpeg().subarray(0, 60);
  const { D1: D2, EVIDENCE: E2 } = await setup(null);
  assert.equal((await processEvidence({ DB: D2, EVIDENCE: E2 }, { reportId: "rep-1", bytes: broken, contentType: "image/jpeg" })).status, 422);
  assert.equal(E2.store.size + EVIDENCE.store.size, 0, "nothing stored for refused files");
  const ok = await processEvidence({ DB: D2, EVIDENCE: E2 }, { reportId: "rep-1", bytes: stripMp4(cat(box("ftyp", "isom"), box("moov", box("udta", "GPS")), box("mdat", "x"))).bytes, contentType: "video/mp4" });
  assert.deepEqual([ok.status, ok.body.people, ok.body.mediaRef.endsWith(".mp4")], [200, "unchecked", true]);
});

test("pipeline API: Bearer INGEST_TOKEN only, so public intake stays closed", async () => {
  const src = phoneJpeg();
  const { D1, EVIDENCE } = await setup(null);
  const env = { DB: D1, EVIDENCE, INGEST_TOKEN: "t0k3n" };
  const post = (auth) => postMedia({ request: new Request("https://x/api/pipeline/media?id=rep-1", { method: "POST", headers: { "content-type": "image/jpeg", ...(auth ? { authorization: auth } : {}) }, body: src }), env });
  assert.equal((await post()).status, 401);
  assert.equal((await post("Bearer wrong")).status, 401);
  const l = console.log; console.log = () => {};
  try { assert.equal((await post("Bearer t0k3n")).status, 200); } finally { console.log = l; }
  assert.equal((await postMedia({ request: new Request("https://x/api/pipeline/media?id=rep-1", { method: "POST", body: src }), env: { DB: D1, EVIDENCE } })).status, 401, "no token configured: refused");
});
