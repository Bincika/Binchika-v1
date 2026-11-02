// Evidence photo/video pipeline (session 58). For one report's file it: checks the file really is the type it claims;
// removes location, camera and time metadata (EXIF, XMP, IPTC, comments, text chunks, MP4 user-data and metadata
// boxes, anything after the end of the image); checks images for people; then stores the processed file privately in
// R2 under full/ with its SHA-256, where the evidence viewer reads it (evidence.js). Pure byte handling, no native
// libraries, so it runs in Pages Functions and Workers. Intake stays closed: the only entry point is
// POST /api/pipeline/media (Bearer INGEST_TOKEN). See docs/PHOTO-PIPELINE.md.
import { mediaKeyOf } from "./evidence.js";

export const PIPELINE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4" };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const PEOPLE_MODEL = "@cf/facebook/detr-resnet-50";   // Workers AI object detection; "person" means people are visible
export const PEOPLE_THRESHOLD = 0.6;

export class PipelineError extends Error {}
const fail = (msg) => { throw new PipelineError(msg); };
const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u32be = (b, at) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
const concat = (parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const sha256Hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");

/** What the bytes actually are, from their signature (not the name or the declared type). */
export function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v)) return "image/png";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length > 12 && ascii(b, 4, 4) === "ftyp") {
    // HEIC/HEIF/AVIF photos share the ISO box format; their brand gives them away, and they are not MP4 video.
    const brand = ascii(b, 8, 4);
    return ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"].includes(brand) ? "image/heic" : "video/mp4";
  }
  return null;
}

// ---------- JPEG ----------
/** EXIF orientation (1–8) from an APP1 "Exif" payload, or 1. Only the orientation is ever carried over. */
export function exifOrientation(data) {
  if (ascii(data, 0, 6) !== "Exif\0\0") return 1;
  const t = data.subarray(6);
  if (t.length < 8) return 1;
  const le = ascii(t, 0, 2) === "II";
  const u16 = (at) => (le ? t[at] | (t[at + 1] << 8) : (t[at] << 8) | t[at + 1]);
  const u32 = (at) => (le ? u32le(t, at) : u32be(t, at));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
  }
  return 1;
}
/** A minimal APP1 segment holding only the orientation, so phone photos still display the right way up. */
export function orientationSegment(v) {
  return new Uint8Array([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, v, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}
export function stripJpeg(b) {
  if (sniff(b) !== "image/jpeg") fail("not a JPEG file");
  const keep = [], removed = new Set();
  let orientation = 1, i = 2, ended = false;
  while (i < b.length) {
    if (b[i] !== 0xff) fail("damaged JPEG (expected a marker)");
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                                   // fill byte
    if (m === 0xd9) { keep.push(b.subarray(i, i + 2)); i += 2; ended = true; break; }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { keep.push(b.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > b.length) fail("damaged JPEG (truncated segment)");
    const len = u16be(b, i + 2);
    if (len < 2 || i + 2 + len > b.length) fail("damaged JPEG (bad segment length)");
    const seg = b.subarray(i, i + 2 + len), data = b.subarray(i + 4, i + 2 + len);
    if (m === 0xda) {                                                    // start of scan: copy the image data to the next marker
      let j = i + 2 + len;
      while (j < b.length - 1 && !(b[j] === 0xff && b[j + 1] !== 0x00 && b[j + 1] !== 0xff && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j >= b.length - 1) fail("damaged JPEG (image data never ends)");
      keep.push(b.subarray(i, j)); i = j; continue;
    }
    if (m === 0xfe) removed.add("comment");
    else if (m === 0xe1) {
      if (ascii(data, 0, 6) === "Exif\0\0") { orientation = exifOrientation(data); removed.add("EXIF (camera, location, time)"); }
      else removed.add("XMP");
    } else if (m === 0xe0 && ascii(data, 0, 5) === "JFIF\0") keep.push(seg);
    else if (m === 0xe2 && ascii(data, 0, 12) === "ICC_PROFILE\0") keep.push(seg);   // colour profile: no personal data
    else if (m === 0xee && ascii(data, 0, 5) === "Adobe") keep.push(seg);            // colour transform needed to decode
    else if (m >= 0xe0 && m <= 0xef) removed.add(m === 0xed ? "IPTC" : `APP${m - 0xe0}`);
    else keep.push(seg);                                                 // tables, frame header, restart interval…
    i += 2 + len;
  }
  if (!ended) fail("damaged JPEG (no end-of-image marker)");
  if (i < b.length) removed.add("data after the end of the image");
  const head = orientation > 1 ? [b.subarray(0, 2), orientationSegment(orientation)] : [b.subarray(0, 2)];
  return { bytes: concat([...head, ...keep]), removed: [...removed], orientation };
}

// ---------- PNG ----------
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD", "acTL", "fcTL", "fdAT"]);
export function stripPng(b) {
  if (sniff(b) !== "image/png") fail("not a PNG file");
  const keep = [b.subarray(0, 8)], removed = new Set();
  let i = 8, ended = false;
  while (i + 12 <= b.length) {
    const len = u32be(b, i), type = ascii(b, i + 4, 4), end = i + 12 + len;
    if (end > b.length) fail("damaged PNG (truncated chunk)");
    if (PNG_KEEP.has(type)) keep.push(b.subarray(i, end));
    else removed.add(["tEXt", "zTXt", "iTXt"].includes(type) ? "text (author, software, comments)" : type === "eXIf" ? "EXIF (camera, location, time)" : type === "tIME" ? "time" : `chunk ${type}`);
    i = end;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended) fail("damaged PNG (no end chunk)");
  if (i < b.length) removed.add("data after the end of the image");
  return { bytes: concat(keep), removed: [...removed], orientation: 1 };
}

// ---------- WebP ----------
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
export function stripWebp(b) {
  if (sniff(b) !== "image/webp") fail("not a WebP file");
  const end = Math.min(b.length, 8 + u32le(b, 4)), keep = [], removed = new Set();
  let i = 12;
  while (i + 8 <= end) {
    const type = ascii(b, i, 4), len = u32le(b, i + 4), stop = i + 8 + len + (len & 1);
    if (i + 8 + len > end) fail("damaged WebP (truncated chunk)");
    if (WEBP_KEEP.has(type)) {
      const chunk = b.slice(i, Math.min(stop, end));
      if (type === "VP8X") chunk[8] &= ~(0x08 | 0x04);                    // clear the "has EXIF" and "has XMP" flags
      keep.push(chunk);
    } else removed.add(type === "EXIF" ? "EXIF (camera, location, time)" : type === "XMP " ? "XMP" : `chunk ${type.trim()}`);
    i = stop;
  }
  if (b.length > end) removed.add("data after the end of the image");
  const body = concat(keep), head = new Uint8Array(12);
  head.set(b.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  return { bytes: concat([head, body]), removed: [...removed], orientation: 1 };
}

// ---------- MP4 ----------
// Metadata boxes are overwritten in place with "free" boxes of the same size, so every offset in the file stays valid.
const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "dinf", "stbl", "edts", "mvex"]);
const MP4_SCRUB = new Set(["udta", "meta", "uuid"]);
export function stripMp4(src) {
  if (sniff(src) !== "video/mp4") fail("not an MP4 file");
  const b = src.slice(), removed = new Set();
  // Walks the top level and the movie header tree (moov and its containers); fragment boxes (moof) are left alone.
  const walk = (start, end) => {
    let i = start;
    while (i + 8 <= end) {
      let size = u32be(b, i), header = 8;
      const type = ascii(b, i + 4, 4);
      if (size === 1) { if (i + 16 > end) fail("damaged MP4 (bad box size)"); size = u32be(b, i + 8) * 0x100000000 + u32be(b, i + 12); header = 16; }
      else if (size === 0) size = end - i;
      if (size < header || i + size > end) fail("damaged MP4 (bad box size)");
      if (MP4_SCRUB.has(type)) {
        b.set([0x66, 0x72, 0x65, 0x65], i + 4);                             // "free"
        b.fill(0, i + header, i + size);
        removed.add(type === "udta" ? "user data (location, camera)" : type === "meta" ? "metadata (location, camera, software)" : "vendor metadata (uuid)");
      } else if (MP4_CONTAINERS.has(type)) walk(i + header, i + size);
      i += size;
    }
  };
  walk(0, b.length);
  return { bytes: b, removed: [...removed], orientation: 1 };
}

const STRIP = { "image/jpeg": stripJpeg, "image/png": stripPng, "image/webp": stripWebp, "video/mp4": stripMp4 };

/** People check for images. Without a detector (no Workers AI binding) the answer is "unchecked", never "none". */
export async function checkPeople(env, bytes, type) {
  if (!type.startsWith("image/") || !env.AI) return "unchecked";
  try {
    const found = await env.AI.run(env.PEOPLE_MODEL || PEOPLE_MODEL, { image: [...bytes] });
    const list = Array.isArray(found) ? found : found?.result ?? [];
    return list.some((d) => d?.label === "person" && Number(d?.score) >= PEOPLE_THRESHOLD) ? "detected" : "none";
  } catch { return "unchecked"; }
}

/**
 * Process one report's file end to end. Returns { status, body }.
 * @param {{ DB, EVIDENCE, AI? }} env
 * @param {{ reportId: string, bytes: Uint8Array, contentType: string }} input
 */
export async function processEvidence(env, { reportId, bytes, contentType }) {
  const no = (status, error) => ({ status, body: { error } });
  if (!env.DB || !env.EVIDENCE) return no(503, "pipeline not configured");
  const r = await env.DB.prepare("SELECT id, pu_code, media_ref, media_sha256 FROM reports WHERE id = ?1").bind(String(reportId ?? "")).first();
  if (!r) return no(404, "report not found");
  if (mediaKeyOf(r.media_ref)) return no(409, "this report's file has already been processed");
  const type = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!PIPELINE_TYPES[type]) return no(415, `accepted types: ${Object.keys(PIPELINE_TYPES).join(", ")} (convert HEIC photos to JPEG and MOV videos to MP4 first)`);
  if (sniff(bytes) !== type) return no(415, "the file's content does not match its declared type");
  if (bytes.length > (type.startsWith("video/") ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES)) return no(413, "file too large");
  const originalSha = await sha256Hex(bytes);
  if (r.media_sha256 && r.media_sha256 !== originalSha) return no(422, "the file does not match the fingerprint sent with the report");
  let out;
  try { out = STRIP[type](bytes); } catch (e) { return no(422, `could not process the file: ${e instanceof PipelineError ? e.message : "unreadable"}`); }
  const people = await checkPeople(env, out.bytes, type);
  const sha = await sha256Hex(out.bytes);
  const key = `full/2027/${/^\d{2}-\d{2}-\d{2}-\d{3}$/.test(r.pu_code ?? "") ? r.pu_code : "no-unit"}/${r.id}.${PIPELINE_TYPES[type]}`;
  if (mediaKeyOf(`r2:${key}`) !== key) return no(422, "cannot store this report's file safely");
  await env.EVIDENCE.put(key, out.bytes, { httpMetadata: { contentType: type }, customMetadata: { report: r.id, sha256: sha, people } });
  const done = await env.DB.prepare(
    `UPDATE reports SET media_ref = ?2, media_sha256 = ?3, original_sha256 = ?4, face_check = ?5, media_removed = ?6, media_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?1 AND COALESCE(media_ref, '') NOT LIKE 'r2:full/%'`
  ).bind(r.id, `r2:${key}`, sha, originalSha, people, JSON.stringify(out.removed)).run();
  if (!done.meta?.changes) { await env.EVIDENCE.delete(key); return no(409, "this report's file has already been processed"); }
  return { status: 200, body: { ok: true, mediaRef: `r2:${key}`, sha256: sha, originalSha256: originalSha, people, removed: out.removed, orientationKept: out.orientation, bytes: out.bytes.length } };
}
