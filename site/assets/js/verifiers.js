// Verifiers page: draft regions, live seat board (taken seats grey out), gated route to the questionnaire.
const meta = await fetch("/data/states.json").then((r) => r.json());
const name = Object.fromEntries(meta.states.map((s) => [s.iso, s.short ?? s.name]));
const TINT = ["#8C6A4F", "#5E7A5A", "#6F6A8F", "#4F7487", "#8A5F6E", "#7A7A4F", "#5F6F7F", "#8A6F3F"];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

document.getElementById("regions").replaceChildren(...meta.verifierRegions.regions.map((r, i) => {
  const li = document.createElement("li");
  li.style.setProperty("--rc", TINT[i % TINT.length]);
  li.innerHTML = `<b>${r.id} · ${r.name}</b><span>${r.states.map((s) => name[s]).join(", ")}</span>`;
  return li;
}));

// "Become a verifier" opens the gated questionnaire
document.getElementById("become-btn")?.addEventListener("click", () => { try { sessionStorage.setItem("binchika-apply", "1"); } catch {} });

// Seat board
let seats = [];
let filter = "szv";
const board = document.getElementById("seat-board");
function drawSeats() {
  const list = seats.filter((s) => s.role === filter);
  const taken = list.filter((s) => s.taken).length;
  document.getElementById("seat-count").innerHTML = `<i></i>${list.length - taken} open · ${taken} taken`;
  const groups = {};
  for (const s of list) (groups[filter === "szv" ? s.state_iso : s.region_id] ??= []).push(s);
  const regionName = Object.fromEntries(meta.verifierRegions.regions.map((r) => [r.id, `${r.id} ${r.name}`]));
  board.innerHTML = Object.entries(groups).map(([k, arr]) => `<div class="seat-group"><b>${esc(filter === "szv" ? name[k] : regionName[k])}</b><div>${arr.map((s) => `<span class="seat${s.taken ? " taken" : ""}" title="${esc(s.code)}: ${s.taken ? "taken" : "open"}">${esc(s.code)}${s.taken ? "<small>Taken</small>" : ""}</span>`).join("")}</div></div>`).join("") || `<p class="muted">The seat board is unavailable right now.</p>`;
}
document.querySelectorAll("[data-seatf]").forEach((b) => b.addEventListener("click", () => {
  filter = b.dataset.seatf;
  document.querySelectorAll("[data-seatf]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  drawSeats();
}));
try { seats = (await fetch("/api/seats").then((r) => r.json())).seats ?? []; } catch {}
drawSeats();
