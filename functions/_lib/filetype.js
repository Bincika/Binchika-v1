// What a contact-form attachment really is, from its bytes (session 150; audit of 16 November 2026).
// The browser's declared type is only a claim: checkAttachment() accepts a file when the claim is on the form's list
// (functions/_lib/contact.js ALLOWED_TYPES) AND the bytes agree. Photos use the evidence pipeline's own sniffer
// (functions/_lib/photo.js sniff); GIF, PDF, the two Office formats and plain text are added here. Pure: no I/O.
import { sniff } from "./photo.js";

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Office files: a plausibility check, not a parser. The archive must begin with the ZIP signature and carry the member
// names as plain bytes in its first or last 64 KB (local headers at the start, the directory at the end). A crafted ZIP
// can carry those names; what this stops is an ordinary archive, program or other file passed off as a document.
const EDGE = 64 * 1024;

const starts = (b, sig) => b.length >= sig.length && sig.every((v, i) => b[i] === v);
const bytesOf = (s) => [...s].map((c) => c.charCodeAt(0));
function has(b, word) {
  const w = bytesOf(word);
  const scan = (from, to) => {
    outer: for (let i = Math.max(0, from); i <= to - w.length; i++) {
      for (let j = 0; j < w.length; j++) if (b[i + j] !== w[j]) continue outer;
      return true;
    }
    return false;
  };
  return b.length <= 2 * EDGE ? scan(0, b.length) : scan(0, EDGE) || scan(b.length - EDGE, b.length);
}
/**
 * Text: nothing that looks binary. No NUL and no control character other than tab, line feed, form feed and carriage
 * return. The encoding is not judged (Excel saves CSV in Windows-1252). UTF-16 with its byte-order mark (Notepad's
 * "Unicode") is accepted when every 16-bit unit passes the same control-character rule.
 */
function looksLikeText(b) {
  if (!b.length) return false;
  const le = b[0] === 0xff && b[1] === 0xfe, be = b[0] === 0xfe && b[1] === 0xff;
  if (le || be) {
    if (b.length < 4 || b.length % 2) return false;
    for (let i = 2; i < b.length; i += 2) {
      const u = le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
      if (u === 0x7f || (u < 0x20 && u !== 0x09 && u !== 0x0a && u !== 0x0c && u !== 0x0d)) return false;
    }
    return true;
  }
  for (const v of b) if (v === 0x7f || (v < 0x20 && v !== 0x09 && v !== 0x0a && v !== 0x0c && v !== 0x0d)) return false;
  return true;
}

/** The type found in the bytes, or null. "text/plain" stands for any plain text (CSV included). MP4 and other archives are null. */
export function attachmentType(b) {
  if (!(b instanceof Uint8Array) || !b.length) return null;
  const photo = sniff(b);
  if (photo) return photo === "video/mp4" ? null : photo;
  if (starts(b, bytesOf("GIF87a")) || starts(b, bytesOf("GIF89a"))) return "image/gif";
  if (starts(b, bytesOf("%PDF-"))) return "application/pdf";
  if (starts(b, [0x50, 0x4b, 0x03, 0x04])) {
    if (!has(b, "[Content_Types].xml")) return null;
    const word = has(b, "word/document.xml"), sheet = has(b, "xl/workbook.xml");
    return word && !sheet ? DOCX : sheet && !word ? XLSX : null;
  }
  if (starts(b, [0x4d, 0x5a]) || starts(b, [0x7f, 0x45, 0x4c, 0x46])) return null;   // Windows and Linux programs
  return looksLikeText(b) ? "text/plain" : null;
}

/**
 * @param {string} declared the type the browser sent
 * @param {Uint8Array} bytes
 * @returns {{ ok: boolean, type?: string }} `type` is what the bytes are, to be used instead of the declared type
 */
export function checkAttachment(declared, bytes) {
  const found = attachmentType(bytes);
  if (!found) return { ok: false };
  const claim = String(declared ?? "");
  if (found === "text/plain") return claim === "text/plain" || claim === "text/csv" ? { ok: true, type: claim } : { ok: false };
  if (found === "image/heic") return claim === "image/heic" || claim === "image/heif" ? { ok: true, type: found } : { ok: false };
  return claim === found ? { ok: true, type: found } : { ok: false };
}
