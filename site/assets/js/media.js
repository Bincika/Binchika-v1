// /media/ (session 92): the media registration request. Posts to /api/contact as topic "media_access", so it shares the
// contact form's honeypot, fill-time check, rate limit, reference, ticket, Inbox copy and automatic reply. The server
// checks every field again (functions/_lib/media.js).
const $ = (id) => document.getElementById(id);
const form = $("media-form");
const renderedAt = Date.now();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("m-status");
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  fd.set("nature", "media_access");
  fd.set("renderedAt", String(renderedAt));
  $("m-send").disabled = true;
  status.textContent = "Sending…";
  try {
    const r = await fetch("/api/contact", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      form.reset();
      status.textContent = `Thank you. Your request has been received.${/^BIN-\d{4}-\d{4,}$/.test(j.reference ?? "") ? ` Your reference is ${j.reference}. Please quote it if you write to us about this request.` : ""} You will also get an automatic confirmation by email.`;
    } else status.textContent = j.error ?? "Your request could not be sent. Please try again.";
  } catch { status.textContent = "Network problem. Please try again."; }
  $("m-send").disabled = false;
});
