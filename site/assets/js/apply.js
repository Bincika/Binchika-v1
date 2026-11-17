// Gated screening self-check: opens after the visitor chooses "Become a verifier" on /verifiers/.
// The self-check runs only in the browser. The application form below it submits to /api/apply, and only
// appears while applications are open.
import { RULES, screen } from "/assets/js/lib/screening.js";
let opened = false;
try { opened = sessionStorage.getItem("binchika-apply") === "1"; } catch {}
if (new URLSearchParams(location.search).get("from") === "verifiers") opened = true;
document.getElementById("gate").hidden = opened;
document.getElementById("gated").hidden = !opened;
document.getElementById("intro").hidden = !opened;

const meta = await fetch("/data/states.json").then((r) => r.json());
for (const s of [...meta.states].sort((a, b) => a.name.localeCompare(b.name, "en-GB"))) document.getElementById("q-state").add(new Option(s.name, s.iso));

// Session 150: a failed or unreadable status is "unknown", never "closed". The form stays hidden either way, and the
// server decides: the page only chooses what to say.
const UNKNOWN = { open: false, unknown: true };
const intake = await fetch("/api/apply").then(async (r) => { const j = await r.json(); return r.ok && typeof j?.open === "boolean" ? j : UNKNOWN; }).catch(() => UNKNOWN);
const COULD_NOT_CHECK = "We could not check whether applications are open. Please check your connection and reload this page.";
const answersOf = (fd) => Object.fromEntries(RULES.map(([q]) => [q, fd.get(q) ?? ""]));

document.getElementById("quiz")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const out = document.getElementById("quiz-result");
  const missing = RULES.filter(([q]) => !fd.get(q)).map(([q]) => q.slice(1));
  out.hidden = false;
  if (!fd.get("state")) { out.innerHTML = "<strong>Please choose your state first.</strong>"; out.focus(); return; }
  if (missing.length) { out.innerHTML = `<strong>Please answer question${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.</strong>`; out.focus(); return; }
  const reasons = RULES.filter(([q, bad]) => fd.get(q) === bad).map(([, , why]) => `<li>${why}</li>`);
  let seats = "";
  try {
    const { seats: board } = await fetch("/api/seats").then((r) => r.json());
    const mine = board.filter((s) => s.state_iso === fd.get("state"));
    const open = mine.filter((s) => !s.taken).length;
    if (mine.length) seats = `<p class="source-note">Your state has ${mine.length} seats, of which ${open} are open: ${mine.map((s) => `<span class="mono"${s.taken ? ' style="opacity:.45;text-decoration:line-through"' : ""}>${s.code}</span>`).join(" ")}.</p>`;
  } catch {}
  const verdict = screen(answersOf(fd));
  out.innerHTML = reasons.length
    ? `<strong>Not eligible for a verifier role this time.</strong><ul>${reasons.join("")}</ul><p>Anyone can still be a citizen monitor. Just photograph the posted result sheet at your polling unit. Citizen reporting is not open yet.</p>`
    : fd.get("q7") === "unsure"
      ? `<strong>Almost.</strong> Question 7 is the heart of the role. Read our <a href="/about/#rules">neutrality rules</a>. ${intake.open ? "You can still apply below, and a person will review your answer." : intake.unknown ? COULD_NOT_CHECK : `If you can answer "yes", you'll be eligible when applications open.`}${seats}`
      : `<strong>You'd be eligible to apply.</strong> ${intake.open ? "Complete the form below to apply." : intake.unknown ? COULD_NOT_CHECK : "Applications are not open yet (see the timetable above)."} Nothing you entered has been saved or sent.${seats}`;
  out.focus();
  const canApply = verdict.status === "eligible" || verdict.status === "submitted";
  document.getElementById("apply-form").hidden = !(canApply && intake.open);
  document.getElementById("apply-closed").hidden = !(canApply && !intake.open && !intake.unknown);
});

// ---------- application (only while open) ----------
if (intake.open) {
  document.getElementById("a-privacy").href = intake.privacyUrl;
  document.getElementById("a-privacy-v").textContent = intake.privacyVersion;
}
document.getElementById("apply-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const quiz = new FormData(document.getElementById("quiz"));
  const say = (t) => { const s = document.getElementById("apply-status"); s.innerHTML = t; s.focus(); };
  const name = document.getElementById("a-name").value.trim();
  if (name.split(/\s+/).length < 2) return say("Please give your full name (first and last name).");
  if (!document.getElementById("a-basis").value) return say("Please say whether this is your state of origin or residence.");
  if (!document.getElementById("a-consent").checked) return say("Please read and accept the privacy notice.");
  say("Submitting…");
  const r = await fetch("/api/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    fullName: name, email: document.getElementById("a-email").value.trim(), state: quiz.get("state"), basis: document.getElementById("a-basis").value,
    role: document.getElementById("a-role").value, vin: document.getElementById("a-vin").value, answers: answersOf(quiz),
    consent: true, privacyVersion: intake.privacyVersion,
  }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return say(j.error ?? "Could not submit. Please try again.");
  if (!j.stored) return say(`<strong>Not eligible this time.</strong> ${j.reasons.join(" ")} Nothing has been saved.`);
  e.target.querySelectorAll("input, select, button").forEach((x) => (x.disabled = true));
  say(`<strong>Application received.</strong> ${j.review ? "A person will review your answer to question 7 before screening. " : ""}We've emailed a confirmation. If you are selected, your seat code will arrive by email from noreply@mail.example.org.`);
});
