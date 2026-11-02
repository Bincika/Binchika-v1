// /join/pledge/#t=TOKEN: show the pledge for this confirmation link, then sign it with a typed name.
// The token travels in the URL fragment (never sent to servers in requests or referrers) and is removed
// from the address bar straight away.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
if (location.hash) history.replaceState(null, "", location.pathname);
let version = "";

const post = async (body) => {
  const r = await fetch("/api/join/pledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  return { ok: r.ok, ...(await r.json().catch(() => ({ error: "Something went wrong. Please try again." }))) };
};
const fail = (msg) => { $("pl-error").textContent = msg; $("pl-error").hidden = false; };

if (!token) fail("This page opens from the confirmation link in your email. Please use that link.");
else {
  const p = await post({});
  if (!p.ok) fail(`${p.error} If your link has expired, the seat has been released. Please contact us.`);
  else {
    version = p.version;
    $("pl-seat").textContent = `${p.seat} · ${p.area} · ${p.publicId}`;
    $("pl-text").textContent = p.body;
    $("pl-version").textContent = p.version;
    $("pl-hash").textContent = p.sha256;
    $("pledge-form").hidden = false;
    $("pl-rulebook").href = `/portal/rulebook/?seat=${encodeURIComponent(p.seat)}`;
  }
}

$("pledge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("pl-name").value.trim();
  const say = (t) => ($("pl-status").textContent = t);
  if (name.split(/\s+/).length < 2) return say("Please type your full name (first and last name).");
  if (!$("pl-accept").checked) return say("Please tick the box to accept the pledge.");
  say("Signing…");
  const r = await post({ typedName: name, version, accept: true });
  if (!r.ok) return say(r.error);
  $("pledge-form").hidden = true;
  $("pl-done-seat").textContent = r.seat;
  $("pl-done-id").textContent = r.publicId;
  $("pl-done-time").textContent = `Signed ${new Date().toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })} ${TENANT.locale.zoneLabel} (our server records the exact time).`;
  $("pl-done").hidden = false;
  $("pl-done").focus();
});
