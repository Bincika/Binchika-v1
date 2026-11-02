// /join/: claim a verifier seat with an invite code → (pick a seat, for SZV / NRV codes) → email + password +
// state/region → confirmation email.
// The code is checked by /api/join/check; nothing is stored in the browser.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const meta = await fetch("/data/states.json").then((r) => r.json());
let seat = null;

const post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, ...(await r.json().catch(() => ({ error: "Something went wrong. Please try again." }))) };
};
const step = (n) => [1, 2, 3].forEach((i) => {
  const li = $(`js-${i}`);
  if (i === n) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  li.classList.toggle("done", i < n);
});

// Format as XXXX-XXXX while typing; the alphabet has no 0/O, 1/I/L or U.
$("j-code").addEventListener("input", (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
  e.target.value = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
});

$("code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("j-code").value;
  if (code.replace("-", "").length !== 8) { $("code-status").textContent = "The code has 8 characters, like K7QM-4XPD."; return; }
  $("code-status").textContent = "Checking…";
  const r = await post("/api/join/check", { code });
  if (!r.ok) { $("code-status").textContent = r.error; return; }
  seat = { ...r, code };
  const exp = new Date(r.expiresAt).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const pick = r.kind && r.kind !== "seat";
  const type = r.role === "nrv" ? "NRV" : "SZV";
  $("seat-card").innerHTML = `<p class="eyebrow" style="margin:0">Seat offered</p><p class="seat-big">${pick ? `Any open ${type} seat` : `<span class="mono">${esc(r.seat)}</span>`} · ${esc(r.area)}</p><p class="source-note" style="margin:0">${r.role === "nrv" ? "Regional Verifier (NRV)" : "State Zone Verifier (SZV)"} · code valid until ${esc(exp)} ${TENANT.locale.zoneLabel}</p>`;
  $("seat-pick").hidden = !pick;
  if (pick) {
    const open = r.seats.filter((s) => s.open).length;
    $("seat-pick-note").textContent = `${open} of ${r.seats.length} ${type} seats for ${r.area} are open. Taken seats are greyed out. ${r.role === "nrv" ? "NRVs serve only the region of their state." : "SZVs serve only the state they applied for."}`;
    $("seat-options").innerHTML = r.seats.map((s) => `<label class="seat-opt${s.open ? "" : " taken"}"><input type="radio" name="seat-choice" value="${esc(s.code)}"${s.open ? "" : " disabled"}>${esc(s.code)}<small>${s.open ? "Open" : "Taken"}</small></label>`).join("");
  }
  $("area-label").textContent = r.role === "nrv" ? "Your region" : "Your state";
  $("j-area").innerHTML = `<option value="">Choose…</option>` + (r.role === "nrv"
    ? meta.verifierRegions.regions.map((g) => `<option value="${g.id}">${esc(g.id)} ${esc(g.name)}</option>`).join("")
    : [...meta.states].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${s.iso}">${esc(s.name)}</option>`).join(""));
  $("code-form").hidden = true;
  $("claim-form").hidden = false;
  step(2);
  $("j-email").focus();
});

$("pw-show").addEventListener("click", (e) => {
  const show = e.target.getAttribute("aria-pressed") !== "true";
  e.target.setAttribute("aria-pressed", String(show));
  e.target.textContent = show ? "Hide passwords" : "Show passwords";
  for (const id of ["j-pass", "j-pass2"]) $(id).type = show ? "text" : "password";
});

$("claim-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("j-email").value.trim(), pass = $("j-pass").value, area = $("j-area").value;
  const say = (t) => ($("claim-status").textContent = t);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say("Please enter the email address you applied with.");
  if (pass.length < 12) return say("Your password needs at least 12 characters.");
  if (pass !== $("j-pass2").value) return say("The two passwords don't match.");
  if (!area) return say(`Please choose your ${seat.role === "nrv" ? "region" : "state"}.`);
  const picked = document.querySelector('input[name="seat-choice"]:checked')?.value ?? null;
  if (seat.kind && seat.kind !== "seat" && !picked) return say("Please choose one of the open seats.");
  say("Creating your account…");
  const r = await post("/api/join/claim", { code: seat.code, email, password: pass, area, seat: picked });
  if (!r.ok) {
    if (/just been taken/.test(r.error ?? "")) {   // someone else got there first: refresh the seat list
      const fresh = await post("/api/join/check", { code: seat.code });
      if (fresh.ok) for (const s of fresh.seats) { const i = document.querySelector(`input[name="seat-choice"][value="${s.code}"]`); if (i && !s.open) { i.checked = false; i.disabled = true; i.parentElement.classList.add("taken"); i.nextElementSibling.textContent = "Taken"; } }
    }
    return say(r.error);
  }
  $("claim-form").hidden = true;
  $("done-email").textContent = email;
  $("done-seat").textContent = r.seat;
  $("done-id").textContent = r.publicId;
  $("done").hidden = false;
  step(3);
  $("done").focus();
});
