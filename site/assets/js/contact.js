// Contact form: topic preselect (?topic=…&party=…), client-side image compression, multipart upload.
const $ = (id) => document.getElementById(id);
const form = $("contact-form");
const renderedAt = Date.now();
const params = new URLSearchParams(location.search);
if (params.get("topic")) $("c-nature").value = params.get("topic");
const party = params.get("party")?.replace(/[^A-Z]/gi, "").slice(0, 8) ?? "";

// Media access request (session 91): its extra fields show, and are required, only for that topic. The server checks
// them again (functions/_lib/media.js); they travel with the message and are stored only in the mailbox.
const MEDIA_FIELDS = ["c-org", "c-org-url", "c-org-type", "c-use", "c-polling", "c-terms"];
function syncMedia() {
  const on = $("c-nature").value === "media_access";
  $("c-media").hidden = !on;
  for (const id of MEDIA_FIELDS) { $(id).required = on; $(id).disabled = !on; }
  $("c-message-label").textContent = on ? "Anything else we should know (for example, the page where the figures will appear)" : "Message";
}
$("c-nature").addEventListener("change", syncMedia);
syncMedia();
if (party && !$("c-message").value) $("c-message").value = `Party: ${party}\n\n`;

const MAX_TOTAL = 10 * 1024 * 1024;
let prepared = []; // { file: Blob, name, original, compressed }
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

// Visually lossless: re-encode large photos as high-quality WebP (q 0.92), longest side ≤ 3000 px.
// Keep the original whenever re-encoding would not make it smaller. Non-images are sent unchanged.
async function compress(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || file.size < 200 * 1024) return { file, name: file.name, original: file.size, compressed: file.size };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
    if (blob.size >= file.size) return { file, name: file.name, original: file.size, compressed: file.size };
    return { file: blob, name: file.name.replace(/\.[^.]+$/, "") + ".webp", original: file.size, compressed: blob.size };
  } catch {
    return { file, name: file.name, original: file.size, compressed: file.size };
  }
}

$("c-files").addEventListener("change", async (e) => {
  const picked = [...e.target.files].slice(0, 5 - prepared.length);
  $("c-status").textContent = picked.length ? "Preparing attachments…" : "";
  for (const f of picked) prepared.push(await compress(f));
  e.target.value = "";
  drawList();
  $("c-status").textContent = "";
});

function drawList() {
  const total = prepared.reduce((a, p) => a + p.compressed, 0);
  $("c-list").innerHTML = prepared.map((p, i) => `<li>${p.name.replace(/[<>&]/g, "")} · ${p.compressed < p.original ? `${kb(p.original)} → ${kb(p.compressed)}` : kb(p.compressed)} <button type="button" class="btn btn-ghost btn-sm" data-rm="${i}" style="min-height:30px;padding:.2rem .6rem">Remove</button></li>`).join("") + (prepared.length ? `<li>Total ${kb(total)} of 10 MB</li>` : "");
  $("c-list").querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => { prepared.splice(Number(b.dataset.rm), 1); drawList(); }));
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("c-status");
  if (!form.reportValidity()) return;
  if (prepared.reduce((a, p) => a + p.compressed, 0) > MAX_TOTAL) { status.textContent = "Attachments are over 10 MB in total."; return; }
  const fd = new FormData(form);
  fd.set("renderedAt", String(renderedAt));
  if (party) fd.set("party", party);
  fd.delete("files");
  for (const p of prepared) fd.append("files", p.file, p.name);
  $("c-send").disabled = true;
  status.textContent = "Sending…";
  try {
    const r = await fetch("/api/contact", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) { form.reset(); syncMedia(); prepared = []; drawList(); status.textContent = `Thank you. Your message has been delivered.${/^BIN-\d{4}-\d{4,}$/.test(j.reference ?? "") ? ` Your reference is ${j.reference}. Please quote it if you write to us about this again.` : ""}`; }
    else status.textContent = j.error ?? "Your message could not be sent. Please try again.";
  } catch { status.textContent = "Network problem. Please try again."; }
  $("c-send").disabled = false;
});
