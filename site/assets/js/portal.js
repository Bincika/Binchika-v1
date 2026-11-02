// Verifier & admin portal with a left-hand control panel.
// Real mode: Supabase magic-link sign-in + RLS tables + /api/admin/*. Preview mode: fictional data, nothing saved.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = new Intl.NumberFormat("en-GB");
// Start every boot request at once (they used to run one after another on slow networks).
const metaP = fetch("/data/states.json").then((r) => r.json());
const cfgP = fetch("/api/config").then((r) => r.json()).catch(() => ({ signIn: false }));
const seatsP = fetch("/api/seats").then((r) => r.json()).then((j) => j.seats ?? []).catch(() => []);
const meta = await metaP;
const stateName = Object.fromEntries(meta.states.map((s) => [s.iso, s.short ?? s.name]));
const regions = meta.verifierRegions.regions;
const regionOf = (iso) => regions.find((r) => r.states.includes(iso));
const cfg = await cfgP;
// Polling-unit code prefix → admin-1 area: the tenant's table (same source as functions/_lib/results.js)
const PU_STATE = TENANT.pollingUnits.statePrefix;
const stateOfPu = (pu) => PU_STATE[String(pu ?? "").slice(0, 2)] ?? null;

let supa = null, me = null, preview = false, viewAs = null, section = "overview";
let flags = [], reports = [], seats = [];
let linkNotice = "";                                      // shown on Account after a password-reset link
let mfaNeeded = false;                                  // OpsAdmin/BinchikAdmin must reach aal2 (authenticator code) first
let adminData = { invites: [], applications: [], history: [], ops: [] };   // BinchikAdmin seat management

const SECTIONS = {
  overview: ["Overview", "M4 13h6V4H4zm0 7h6v-5H4zm10 0h6v-9h-6zm0-16v5h6V4z"],
  flags: ["Flags", "M5 21V4h11l-1 4 1 4H5"],
  reports: ["Incoming reports", "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5"],
  hierarchy: ["Hierarchy", "M12 3v4M5 11h14M5 11v4M12 7v8M19 11v4M3 15h4v5H3zm7 0h4v5h-4zm7 0h4v5h-4z"],
  seats: ["Seats", "M4 10h16v6H4zM6 16v4M18 16v4M6 10V6h12v4"],
  metrics: ["Metrics", "M4 20V10M10 20V4M16 20v-7M22 20H2"],
  meetings: ["Meetings", "M3 5h18v15H3zM3 9h18M8 3v4M16 3v4"],
  mail: ["Inbox & Sent", "M3 5h18v14H3zM3 6l9 7 9-7"],
  contacts: ["Contacts & campaigns", "M16 11a4 4 0 1 0 0-8M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a6 6 0 0 1 12 0M16 15a6 6 0 0 1 6 6"],
  viewas: ["View as…", "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  rulebook: ["Rule book", "M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11"],
  account: ["Settings / Account", "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0"],
};
const ROLE_SECTIONS = {
  szv: ["overview", "flags", "reports", "hierarchy", "seats", "rulebook", "account"],
  nrv: ["overview", "flags", "reports", "hierarchy", "seats", "rulebook", "account"],
  admin: ["overview", "flags", "reports", "metrics", "hierarchy", "seats", "rulebook", "account"],
  superadmin: ["overview", "flags", "metrics", "meetings", "mail", "contacts", "viewas", "reports", "hierarchy", "seats", "rulebook", "account"],
};
// Display names only: the role keys stay "admin" / "superadmin" in the database and RLS.
const ROLE_LABEL = { szv: "State Zone Verifier", nrv: "Regional Verifier", admin: "OpsAdmin", superadmin: "BinchikAdmin" };
const ROLE_SHORT = { szv: "SZV", nrv: "NRV", admin: "OpsAdmin", superadmin: "BinchikAdmin" };
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

// The lens: whose area are we looking at? A superadmin's "view as" swaps it, read-only.
const lens = () => viewAs ?? me;
const lensStates = () => {
  const l = lens();
  if (!l || l.role === "admin" || l.role === "superadmin") return meta.states.map((s) => s.iso);
  if (l.role === "szv") return [l.state_iso];
  return regions.find((r) => r.id === l.region_id)?.states ?? [];
};
const readOnly = () => Boolean(viewAs);
const areaName = (l) => (l.role === "szv" ? stateName[l.state_iso] : l.role === "nrv" ? regions.find((r) => r.id === l.region_id)?.name ?? "" : "All of Nigeria");

function drawSide() {
  $("cp-role").textContent = me ? ROLE_LABEL[me.role] : "Portal";
  $("cp-id").innerHTML = me ? `<span class="id-badge">${esc(me.seat_code ?? ROLE_SHORT[me.role])} <code>${esc(me.public_id)}</code></span>${mfaNeeded ? "" : `<button type="button" class="linklike cp-settings" id="cp-settings">Settings / Account: sign-in link, password${["admin", "superadmin"].includes(me.role) ? ", MFA" : ""}</button>`}` : "";
  $("cp-settings")?.addEventListener("click", () => { section = "account"; render(); });
  const list = me ? (mfaNeeded ? [] : ROLE_SECTIONS[me.role]) : ["overview"];
  const openCount = flags.filter((f) => !["approved", "rejected", "dismissed"].includes(f.status) && lensStates().includes(f.state_iso)).length;
  $("cp-nav").innerHTML = list.map((k) => `<button type="button" data-sec="${k}"${section === k ? ' aria-current="page"' : ""}>${icon(SECTIONS[k][1])}<span>${SECTIONS[k][0]}</span>${k === "flags" && openCount ? `<em>${openCount}</em>` : ""}${k === "mail" && mailUnread() ? `<em>${mailUnread()}</em>` : ""}</button>`).join("");
  $("cp-nav").querySelectorAll("[data-sec]").forEach((b) => b.addEventListener("click", () => { section = b.dataset.sec; render(); }));
}

function signInView() {
  return `<div class="glass-bar" style="grid-template-columns:1fr"><div><h2>Sign in</h2>${linkNotice ? `<p class="callout">${esc(linkNotice)}</p>` : ""}
    ${cfg.signIn ? `<form class="portal-form" id="pw-form"><label>Email<input type="email" id="si-email" required autocomplete="username"></label><label>Password<input type="password" id="si-pass" required autocomplete="current-password"></label>
        <div class="cta-row"><button class="btn btn-solid" type="submit">Sign in</button><button class="btn btn-ghost" type="button" id="otp-btn">Email me a sign-in link instead</button></div>
        <p class="form-status" id="pw-status" role="status"></p>
        <p class="source-note"><button type="button" class="linklike" id="reset-btn">Forgot your password?</button> We'll email a one-time link that opens Settings / Account, where you can set a new one. Selected verifiers claim their seat at <a href="/join/">binchika.com/join</a> with the code from their invitation email.</p></form>`
      : `<p><strong>Sign-in is not switched on yet.</strong> Selected verifiers will receive a one-time code by email.</p>`}
    <p class="muted" style="margin-top:1rem">See how each dashboard works first:</p>
    <div class="seg" role="group" aria-label="Preview a role">${["szv", "nrv", "admin", "superadmin"].map((r) => `<button type="button" data-prev="${r}">${ROLE_SHORT[r]}</button>`).join("")}</div></div></div>`;
}

const kpi = (label, value, tone = 1) => `<div class="kpi k${tone}"><b>${value}</b><span>${esc(label)}</span></div>`;
function overviewView() {
  const st = lensStates();
  const f = flags.filter((x) => st.includes(x.state_iso));
  const mySeats = seats.filter((x) => (x.role === "szv" ? st.includes(x.state_iso) : regions.some((r) => r.id === x.region_id && r.states.some((y) => st.includes(y)))));
  return `<h2>${esc(areaName(lens()))}</h2>
    <div class="kpis">${kpi("Open flags", f.filter((x) => ["open", "nrv_review"].includes(x.status)).length, 3)}${kpi("Escalated", f.filter((x) => ["escalated", "investigating", "ai_done"].includes(x.status)).length, 4)}${kpi("Reports in area", nf.format(reports.filter((r) => st.includes(stateOfPu(r.pu_code))).length), 1)}${kpi("Seats filled", `${mySeats.filter((x) => x.taken).length}/${mySeats.length}`, 2)}</div>
    <h3>Latest flags</h3>${flagList(f.slice(0, 4))}`;
}
function actions(f) {
  if (readOnly()) return "";
  const r = me.role;
  if (r === "nrv" && ["open", "nrv_review"].includes(f.status)) return `<textarea class="pick" data-find="${f.id}" rows="2" placeholder="Findings (required to escalate or dismiss)"></textarea><button class="btn btn-solid btn-sm" data-act="escalated" data-id="${f.id}">Escalate to OpsAdmin</button><button class="btn btn-ghost btn-sm" data-act="dismissed" data-id="${f.id}">Dismiss</button>`;
  if (r === "admin" && ["escalated", "investigating"].includes(f.status)) return `<button class="btn btn-solid btn-sm" data-act="investigating" data-id="${f.id}">Start AI re-investigation</button>`;
  if (r === "superadmin" && ["escalated", "investigating", "ai_done"].includes(f.status)) return `<input class="pick" data-note="${f.id}" placeholder="Decision note (required)"><button class="btn btn-solid btn-sm" data-act="approve" data-id="${f.id}">Approve correction → ledger</button><button class="btn btn-ghost btn-sm" data-act="reject" data-id="${f.id}">Reject</button>`;
  return "";
}
function flagList(list) {
  return `<ul class="flag-list">${list.length ? list.map((f) => `<li class="flag-item"><header><strong class="mono">${esc(f.pu_code)}</strong><span class="chip ${f.status === "approved" ? "ok" : ["rejected", "dismissed"].includes(f.status) ? "bad" : "warn"}"><i></i>${esc(f.status.replace("_", " "))}</span></header><p style="margin:.4rem 0 0">${esc(f.reason)}</p><p class="source-note" style="margin:.3rem 0 0">${esc(stateName[f.state_iso])} · ${esc(f.race)} · raised by ${esc(f.raised_by_public_id ?? "?")}${f.nrv_public_id ? ` · NRV ${esc(f.nrv_public_id)}` : ""}</p>${f.nrv_findings ? `<p style="margin:.3rem 0 0;font-size:.9rem"><strong>NRV findings:</strong> ${esc(f.nrv_findings)}</p>` : ""}${f.ai_summary ? `<p style="margin:.3rem 0 0;font-size:.9rem"><strong>AI re-check:</strong> ${esc(f.ai_summary)}</p>` : ""}<div class="flag-actions">${actions(f)}</div></li>`).join("") : `<li class="muted">No flags here.</li>`}</ul>`;
}
function flagsView() {
  const raise = !readOnly() && me.role === "szv" ? `<form class="portal-form panel" id="flag-form" style="margin-bottom:1rem"><h3>Raise a flag</h3><div class="form-grid"><label>Polling unit code<input id="f-pu" required pattern="\\d{2}-\\d{2}-\\d{2}-\\d{3}" placeholder="24-01-01-001" value="${esc(flagDraft?.pu ?? "")}"></label><label>Race<select id="f-race">${[["president", "President"], ["senate", "Senate"], ["house", "House"], ["governor", "Governor"], ["state-assembly", "State Assembly"]].map(([v, l]) => `<option value="${v}"${flagDraft?.race === v ? " selected" : ""}>${l}</option>`).join("")}</select></label><label class="wide">What doesn't add up?<textarea id="f-reason" required minlength="10" rows="3"></textarea></label></div><button class="btn btn-solid btn-sm" type="submit">Raise flag</button> <span class="form-status" id="f-status" role="status"></span></form>` : "";
  return `<h2>Flags</h2>${raise}${flagList(flags.filter((f) => lensStates().includes(f.state_iso)))}`;
}
// Evidence types (session 55): the posted result sheet, or an alternative accepted only after a verifier's audit.
const EVIDENCE_LABEL = { ec8a: "Result sheet", video: "Video", handwritten: "Handwritten numbers", board: "Photo of the board" };
const canAudit = () => !readOnly() && ["szv", "nrv"].includes(me?.role);
function evidenceCell(r) {
  const ev = r.evidence ?? "ec8a";
  if (ev === "ec8a") return EVIDENCE_LABEL.ec8a;
  const state = r.audit_status === "approved" ? `approved by ${esc(r.audited_by ?? "a verifier")}` : r.audit_status === "rejected" ? `rejected by ${esc(r.audited_by ?? "a verifier")}` : "waiting for audit";
  const buttons = r.audit_status === "pending" && canAudit()
    ? `<span class="audit-btns"><button class="btn btn-solid btn-sm" type="button" data-audit="approved" data-id="${esc(r.id)}">Approve</button><button class="btn btn-ghost btn-sm" type="button" data-audit="rejected" data-id="${esc(r.id)}">Reject</button></span>` : "";
  return `${esc(EVIDENCE_LABEL[ev] ?? ev)} <span class="pill-lower">lower-confidence · ${state}</span>${buttons}`;
}
// Evidence viewer (session 57): SZV/NRV only, own area, MFA-verified session; shown in a dialog, never cached.
const viewBtn = (r) => (r.has_media && canAudit() ? ` <button class="btn btn-ghost btn-sm" type="button" data-view="${esc(r.id)}">View</button>` : "");
let viewerUrl = null;
const PREVIEW_EVIDENCE = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#efe8dc"/><rect x="40" y="30" width="400" height="240" rx="8" fill="#fff" stroke="#8a6f3f" stroke-width="3"/><text x="240" y="80" font-family="Arial" font-size="20" font-weight="700" text-anchor="middle" fill="#3b2414">RESULTS BOARD (sample)</text><g font-family="Arial" font-size="18" fill="#3b2414"><text x="90" y="130">ALPHA</text><text x="330" y="130">212</text><text x="90" y="170">BRAVO</text><text x="330" y="170">187</text><text x="90" y="210">CHARLIE</text><text x="330" y="210">41</text></g><text x="240" y="255" font-family="Arial" font-size="13" text-anchor="middle" fill="#8a6f3f">Preview only: not real evidence</text></svg>`);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
function closeViewer() {
  const d = $("ev-viewer");
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  if (d?.open) d.close();
  d?.remove();
}
async function openViewer(id) {
  const r = reports.find((x) => x.id === id);
  closeViewer();
  const d = document.createElement("dialog");
  d.id = "ev-viewer"; d.className = "panel ev-viewer";
  d.innerHTML = `<div class="ev-head"><h2>Evidence · <span class="mono">${esc(r?.pu_code ?? "")}</span></h2><button class="icon-btn" type="button" id="ev-close" aria-label="Close">✕</button></div>
    <p class="muted" style="margin:.2rem 0 .6rem">${esc(EVIDENCE_LABEL[r?.evidence ?? "ec8a"] ?? "")} · shown only to verifiers for this area. Do not save, forward or share it.</p>
    <div id="ev-body" aria-live="polite"><p class="muted">Loading…</p></div>`;
  document.body.append(d);
  d.addEventListener("close", closeViewer);
  $("ev-close").addEventListener("click", closeViewer);
  d.showModal();
  const body = $("ev-body");
  // Session 88: the photo and the reading side by side; confirm or reject from here.
  const split = (left) => { body.innerHTML = `<div class="ev-split"><div class="ev-left">${left}</div><div class="ev-right">${readingPanel(r ?? {})}</div></div>`; body.querySelectorAll("[data-rv]").forEach((b) => b.addEventListener("click", () => submitReview(id, b.dataset.rv))); };
  if (preview) return split(r?.has_media ? `<img class="ev-media" src="${PREVIEW_EVIDENCE}" alt="Sample results board (preview, not real evidence)"><p class="source-note">Preview mode: a sample image, no real evidence.</p>` : `<p class="muted">No photo stored for this reading.</p>`);
  if (!r?.has_media) return split(`<p class="muted">No photo stored for this reading. Confirm only if you have seen the posted sheet; otherwise reject.</p>`);
  const { data: lvl } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
  if (lvl?.currentLevel !== "aal2") {
    body.innerHTML = `<p><strong>Viewing evidence needs your authenticator app.</strong> Verify once for this session.</p><div id="ev-mfa"></div>`;
    return mfaInto($("ev-mfa"), async () => openViewer(id));
  }
  const token = (await supa.auth.getSession()).data.session?.access_token;
  const res = await fetch(`/api/portal/evidence-media?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) { const j = await res.json().catch(() => ({})); body.innerHTML = `<p class="callout">${esc(j.error ?? `Could not load the evidence (${res.status}).`)}</p>`; return; }
  const blob = await res.blob();
  const want = res.headers.get("x-evidence-sha256") || r?.media_sha256 || "";
  const got = hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  viewerUrl = URL.createObjectURL(blob);
  const media = blob.type.startsWith("video/")
    ? `<video class="ev-media" src="${viewerUrl}" controls playsinline preload="metadata"></video>`
    : `<img class="ev-media" src="${viewerUrl}" alt="Evidence for polling unit ${esc(r?.pu_code ?? "")}">`;
  const check = !want ? `<p class="source-note">No fingerprint was recorded when this arrived, so it cannot be checked.</p>`
    : want === got ? `<p class="ev-ok">Fingerprint matches the one recorded when it arrived (SHA-256 ${esc(got.slice(0, 12))}…).</p>`
    : `<p class="callout"><strong>Fingerprint does not match the one recorded when it arrived.</strong> Do not approve it: reject it and raise a flag.</p>`;
  const people = res.headers.get("x-evidence-people") || r?.face_check || "unchecked";
  const peopleNote = people === "none" ? `<p class="source-note">Checked for people: none found. Still never share it.</p>`
    : people === "detected" ? `<p class="callout"><strong>People may be visible in this file.</strong> It is withheld from any publication. Never save or share it.</p>`
    : `<p class="callout"><strong>Not checked for people.</strong> Treat it as if people are visible: it is withheld from any publication.</p>`;
  split(media + check + peopleNote);
}
// Session 88: readings count only once a verifier confirms them, beside the photo. Plain-language statuses, the sheet's
// control totals and any OCR proposal (with per-field confidence) are shown next to the evidence.
const STATUS_LABEL = { received: "Received", ocr_pending: "Waiting for a reading", ocr_done: "Read by machine (confident)", needs_review: "Needs a verifier's check", verified: "Confirmed by a verifier", rejected: "Rejected" };
const UNIT_LABEL = { high: "High confidence, posted", held: "High, but held back by a check", lower: "Lower confidence", medium: "Not yet high", low: "Not yet high", insufficient: "Not enough readings" };
const GATE_LABEL = { "polling-unit": "polling-unit code", consensus: "three agreeing readings", "human-or-confident": "confirmed readings", "control-totals": "sheet totals balance", baseline: "no count above the register" };
const canReview = (r) => canAudit() && (r.evidence ?? "ec8a") === "ec8a" && r.status === "needs_review" && r.tally;
function statusCell(r) {
  const label = esc(r.status_label ?? STATUS_LABEL[r.status] ?? r.status);
  const sheet = r.tally && (r.evidence ?? "ec8a") === "ec8a" ? (r.balanced ? `<span class="chip ok"><i></i>sheet balances</span>` : `<span class="chip warn"><i></i>${r.controls ? "sheet does not balance" : "no sheet totals yet"}</span>`) : "";
  const u = r.unit ? `<br><small class="muted">Unit: ${esc(UNIT_LABEL[r.unit.status] ?? r.unit.status)} · ${r.unit.reports} reading${r.unit.reports === 1 ? "" : "s"}${r.unit.irev && r.unit.irev.match === false ? " · <strong>differs from IReV</strong>" : r.unit.irev ? " · matches IReV" : ""}</small>` : "";
  const btn = canReview(r) ? ` <button class="btn btn-solid btn-sm" type="button" data-review="${esc(r.id)}">Check reading</button>` : "";
  return `${label} ${sheet}${btn}${u}`;
}
function readingPanel(r) {
  const tally = r.tally ? Object.entries(r.tally).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="num">${esc(v)}</td></tr>`).join("") : "";
  const k = r.controls ?? {};
  const lowFields = (r.ocr?.fields ?? []).filter((f) => f.confidence < 0.9).map((f) => f.name);
  const ocr = r.ocr && r.ocr.status === "proposed"
    ? `<p class="source-note"><strong>Machine reading (proposal only).</strong> Lowest field confidence ${Math.round((r.ocr.confidence ?? 0) * 100)}%${lowFields.length ? `; check carefully: ${esc(lowFields.join(", "))}` : ""}.</p>${r.ocr.transcript ? `<p class="mono ev-transcript">${esc(r.ocr.transcript)}</p>` : ""}`
    : r.ocr ? `<p class="source-note">Machine reading: ${esc(r.ocr.status === "withheld" ? `withheld (${r.ocr.reason ?? "not clear enough"})` : "switched off")}. Read the photo yourself.</p>`
    : `<p class="source-note">No machine reading: the numbers below were typed in by the reporter.</p>`;
  const problems = (r.problems ?? []).length ? `<ul class="callout">${r.problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const gates = r.unit?.gates?.gates ? `<p class="source-note">Before posting, every check must pass: ${r.unit.gates.gates.map((g) => `${g.pass ? "✓" : "✗"} ${esc(GATE_LABEL[g.id] ?? g.id)}`).join(" · ")}.</p>` : "";
  const form = canReview(r) ? `<div class="ev-review"><p><strong>Does this reading match the photo exactly?</strong> Confirm only if every party figure and the totals match. Otherwise reject it: you cannot change the numbers.</p>
      <div class="form-grid"><label>Register<input id="rv-register" inputmode="numeric" value="${esc(k.register ?? "")}"></label><label>Accredited<input id="rv-accredited" inputmode="numeric" value="${esc(k.accredited ?? "")}"></label><label>Rejected ballots<input id="rv-rejected" inputmode="numeric" value="${esc(k.rejected ?? "")}"></label>
      <label class="wide">Reason someone else can check (required)<textarea id="rv-note" rows="2" minlength="10" maxlength="500"></textarea></label></div>
      <div class="cta-row"><button class="btn btn-solid btn-sm" type="button" data-rv="confirm">Confirm reading</button><button class="btn btn-ghost btn-sm" type="button" data-rv="reject">Reject reading</button></div><p class="form-status" id="rv-status" role="status"></p></div>` : "";
  return `<h3>Reading</h3>${tally ? `<table class="data ev-tally"><tbody>${tally}</tbody></table>` : `<p class="muted">No reading yet.</p>`}
    <p class="source-note">Register ${esc(k.register ?? "—")} · accredited ${esc(k.accredited ?? "—")} · rejected ${esc(k.rejected ?? "—")}</p>${ocr}${problems}${gates}${form}`;
}
async function submitReview(id, decision) {
  const st = $("rv-status");
  const note = $("rv-note")?.value.trim() ?? "";
  if (note.length < 10) { st.textContent = "Write a reason of at least 10 characters first."; $("rv-note")?.focus(); return; }
  const num = (x) => { const v = $(x)?.value.trim(); return v === "" || v == null ? undefined : Number(v); };
  const controls = { register: num("rv-register"), accredited: num("rv-accredited"), rejected: num("rv-rejected") };
  if (preview) { const r = reports.find((x) => x.id === id); if (r) Object.assign(r, { status: decision === "confirm" ? "verified" : "rejected", status_label: undefined, audited_by: me.public_id }); closeViewer(); return render(); }
  const token = (await supa.auth.getSession()).data.session?.access_token;
  const res = await fetch("/api/portal/review", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reportId: id, decision, note, controls }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { st.innerHTML = `${esc(j.error ?? `Could not save (${res.status}).`)}${(j.problems ?? []).length ? `<br>${j.problems.map(esc).join("<br>")}` : ""}`; return; }
  st.textContent = `Saved: ${decision === "confirm" ? "confirmed" : "rejected"}. The unit is now ${UNIT_LABEL[j.unit?.status] ?? j.unit?.status ?? "unchanged"}.`;
  await loadReal();
}
// Dynamic flagging: "Flag unit" on any row opens the flag form with the unit and race already filled in.
let flagDraft = null;
function flagFromRow(id) { const r = reports.find((x) => x.id === id); flagDraft = r ? { pu: r.pu_code, race: r.race } : null; section = "flags"; render(); $("f-reason")?.focus(); }
function reportsView() {
  const st = lensStates();
  const list = reports.filter((r) => st.includes(stateOfPu(r.pu_code)));
  const pending = list.filter((r) => (r.evidence ?? "ec8a") !== "ec8a" && r.audit_status === "pending").length;
  const audit = pending && canAudit()
    ? `<div class="panel audit-box"><h3>Audit alternative evidence (${pending} waiting)</h3><p class="muted" style="margin:.2rem 0 .6rem">When Form EC8A is not available, a video, handwritten numbers or a photo of the board counts only after a verifier has audited it, and it stays lower-confidence: it can never make a unit high-confidence on its own. Check that it shows this polling unit and that the numbers match it, then approve or reject with a reason someone else can check.</p><label>Reason for your decision (required)<textarea id="audit-note" rows="2" minlength="10" maxlength="500"></textarea></label><p class="form-status" id="audit-status" role="status"></p></div>` : "";
  return `<h2>Incoming citizen reports</h2><p class="muted">Reporters stay anonymous: you see units and tallies, never who sent them.</p>${audit}
    ${list.length ? `<div class="table-scroll" style="max-height:440px"><table class="data"><thead><tr><th>Unit</th><th>Race</th><th>Channel</th><th>Evidence</th><th>Status</th><th>Received (WAT)</th></tr></thead><tbody>${list.map((r) => `<tr><td class="mono">${esc(r.pu_code ?? "—")}</td><td>${esc(r.race ?? "—")}</td><td>${esc(r.channel ?? "—")}</td><td>${evidenceCell(r)}${viewBtn(r)}</td><td>${statusCell(r)}${!readOnly() && me.role === "szv" && r.pu_code ? ` <button class="btn btn-ghost btn-sm" type="button" data-flagrow="${esc(r.id)}">Flag unit</button>` : ""}</td><td>${new Date(r.received_at).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone })}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No reports in this area yet.</p>`}`;
}
async function auditReport(id, decision) {
  const note = $("audit-note")?.value.trim() ?? "";
  const status = $("audit-status");
  if (note.length < 10) { status.textContent = "Write a reason of at least 10 characters first."; $("audit-note")?.focus(); return; }
  if (preview) { const r = reports.find((x) => x.id === id); if (r) Object.assign(r, { audit_status: decision, audited_by: me.public_id }); return render(); }
  const token = (await supa.auth.getSession()).data.session?.access_token;
  const res = await fetch("/api/portal/evidence", { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ reportId: id, decision, note }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { status.textContent = j.error ?? `Could not save (${res.status}).`; return; }
  status.textContent = `Saved: ${decision}. The unit is now ${j.unit?.status ?? "unchanged"}.`;
  await loadReal();
}
function seatsView() {
  const groups = {};
  for (const s of seats) (groups[s.role === "szv" ? `SZV · ${stateName[s.state_iso]}` : `NRV · ${s.region_id}`] ??= []).push(s);
  return `<h2>Seats</h2><p class="muted">Taken seats are greyed out. Holders are never shown.</p>${seatAdminView()}<div class="seat-board">${Object.entries(groups).map(([k, arr]) => `<div class="seat-group"><b>${esc(k)}</b><div>${arr.map((s) => `<span class="seat${s.taken || s.pending ? " taken" : ""}">${esc(s.code)}${s.taken ? "<small>Taken</small>" : s.pending ? "<small>Pending</small>" : ""}</span>`).join("")}</div></div>`).join("")}</div>`;
}
// BinchikAdmin: invite eligible applicants (one exact seat, or any open SZV / NRV seat in their area; code by email
// only), revoke unused codes, release seats, appoint the three OpsAdmins, and read the seat history.
const watTime = (t) => (t ? new Date(t).toLocaleString("en-GB", { timeZone: TENANT.locale.timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + ` ${TENANT.locale.zoneLabel}` : "—");
const appsFor = (s) => adminData.applications.filter((a) => a.role_sought === s.role && (s.role === "szv" ? a.state_iso === s.state_iso : regions.find((r) => r.id === s.region_id)?.states.includes(a.state_iso)));
const openIn = (kind, iso) => seats.filter((s) => s.role === kind && !s.taken && !s.pending && (kind === "szv" ? s.state_iso === iso : s.region_id === regionOf(iso)?.id));
const appOption = (a, extra = "") => `<option value="${a.id}">Score ${a.score ?? "–"} · ${esc(stateName[a.state_iso])} · applied ${new Date(a.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · ref ${a.id.slice(0, 8)}${extra}</option>`;
const inviteTarget = (i) => (i.kind && i.kind !== "seat" && !i.seat_code ? `Any ${i.kind.toUpperCase()} · ${i.kind === "szv" ? stateName[i.state_iso] : i.region_id}` : i.seat_code);
function seatAdminView() {
  if (me?.role !== "superadmin" || readOnly()) return "";
  const open = seats.filter((s) => !s.taken && !s.pending), held = seats.filter((s) => s.taken || s.pending);
  const ops = adminData.ops ?? [];
  const EV = { invited: "Code emailed", claimed: "Account created", pledged: "Pledge signed", released: "Released", invite_revoked: "Invite revoked", invite_expired: "Invite expired", appointed: "OpsAdmin appointed" };
  return `<div class="metric-grid" style="margin-bottom:1.2rem">
    <form class="portal-form panel" id="inv-form"><b>Invite a verifier</b><p class="source-note">The code goes to the applicant by email only, from noreply@binchika.com. You never see it. OpsAdmin seats are never offered by code.</p>
      <label>Code type<select id="inv-kind"><option value="szv">SZV code: invitee picks any open SZV seat in their state</option><option value="nrv">NRV code: invitee picks any open NRV seat in their region</option><option value="seat">One specific seat</option></select></label>
      <label id="inv-seat-wrap" hidden>Open seat<select id="inv-seat"><option value="">Choose…</option>${open.map((s) => `<option value="${s.code}">${esc(s.code)} · ${esc(seatArea(s))}</option>`).join("")}</select></label>
      <label>Eligible applicant<select id="inv-app" required></select></label>
      <label>Window<select id="inv-hours"><option value="24">24 hours (first wave)</option><option value="6">6 hours (backfill)</option></select></label>
      <button class="btn btn-solid btn-sm" type="submit">Email the code</button><p class="form-status" id="inv-status" role="status"></p></form>
    <form class="portal-form panel" id="rel-form"><b>Release a seat</b><p class="source-note">Deactivates the holder, blocks their sign-in and retires their public ID for good. A pending invite is revoked instead. The reason stays private.</p>
      <label>Seat<select id="rel-seat" required><option value="">Choose…</option>${held.map((s) => `<option value="${s.code}">${esc(s.code)} · ${esc(seatArea(s))} · ${s.taken ? "taken" : "pending"}</option>`).join("")}${ops.filter((o) => o.holder).map((o) => `<option value="${o.code}">${esc(o.code)} · OpsAdmin ${esc(o.holder)}</option>`).join("")}</select></label>
      <label>Reason (at least 10 characters)<textarea id="rel-reason" rows="2" minlength="10" maxlength="500" required></textarea></label>
      <button class="btn btn-ghost btn-sm" type="submit">Release seat</button><p class="form-status" id="rel-status" role="status"></p></form>
    <form class="portal-form panel" id="ops-form"><b>OpsAdmin seats (exactly three)</b><p class="source-note">Appointed by you only, never by code or application. OpsAdmins help with reviews; they can never become BinchikAdmin, approve corrections, invite or release. They must set up an authenticator app before any admin tool works. The address is locked to the seat.</p>
      <ul class="ops-list">${(ops.length ? ops : [1, 2, 3].map((n) => ({ code: `OPS-${n}` }))).map((o) => `<li><span class="mono">${esc(o.code)}</span> ${o.holder ? `<span class="seat taken">${esc(o.holder)}</span>` : `<span class="muted">open</span>`}</li>`).join("")}</ul>
      ${ops.some((o) => !o.holder) ? `<label>Seat<select id="ops-seat" required>${ops.filter((o) => !o.holder).map((o) => `<option value="${o.code}">${esc(o.code)}</option>`).join("")}</select></label>
      <label>Appointee's email (never used on Binchika before)<input id="ops-email" type="email" autocomplete="off" required></label>
      <button class="btn btn-ghost btn-sm" type="submit">Appoint OpsAdmin</button>` : `<p class="muted">All three OpsAdmin seats are filled. Release one to appoint someone else.</p>`}<p class="form-status" id="ops-status" role="status"></p></form>
    </div>
    <div class="panel" style="margin-bottom:1.2rem"><b>Live invites</b>${adminData.invites.length ? `<div class="table-scroll"><table class="data inv-table"><thead><tr><th>Seat</th><th>Status</th><th>Expires</th><th>By</th><th></th></tr></thead><tbody>${adminData.invites.map((i) => `<tr><td class="mono">${esc(inviteTarget(i))}</td><td>${i.status === "claimed" ? "Awaiting pledge" : `Code sent (${i.window_hours} h)`}</td><td>${watTime(i.status === "claimed" ? i.confirm_expires_at : i.expires_at)}</td><td class="mono">${esc(i.created_by_public_id ?? "")}</td><td>${i.status === "sent" && i.id ? `<button type="button" class="btn btn-ghost btn-sm" data-revoke="${esc(i.id)}">Revoke</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No live invites.</p>`}<p class="form-status" id="revoke-status" role="status"></p>
      <b style="display:block;margin-top:1rem">Seat history</b>${adminData.history.length ? `<div class="table-scroll" style="max-height:260px"><table class="data inv-table"><thead><tr><th>When</th><th>Seat</th><th>Event</th><th>ID</th><th>Reason (private)</th></tr></thead><tbody>${adminData.history.map((h) => `<tr><td>${watTime(h.at)}</td><td class="mono">${esc(h.seat_code)}</td><td>${esc(EV[h.event] ?? h.event)}${h.pledge_version ? ` · ${esc(h.pledge_version)}` : ""}</td><td class="mono">${esc(h.public_id ?? "")}</td><td style="white-space:normal">${esc(h.reason ?? "")}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}</div>`;
}
function wireSeatAdmin() {
  const inv = $("inv-form");
  if (!inv) return;
  const fillApps = () => {
    const kind = $("inv-kind").value;
    $("inv-seat-wrap").hidden = kind !== "seat";
    $("inv-seat").required = kind === "seat";
    let html;
    if (kind === "seat") {
      const s = seats.find((x) => x.code === $("inv-seat").value);
      const list = s ? appsFor(s) : [];
      html = !s ? `<option value="">Choose a seat first</option>` : list.length ? list.map((a) => appOption(a)).join("") : `<option value="">No eligible applicants for this seat yet</option>`;
    } else {
      const list = adminData.applications.filter((a) => a.role_sought === kind).map((a) => [a, openIn(kind, a.state_iso).length]).filter(([, n]) => n > 0);
      html = list.length ? list.map(([a, n]) => appOption(a, ` · ${n} open ${kind.toUpperCase()} seat${n === 1 ? "" : "s"}`)).join("") : `<option value="">No eligible ${kind.toUpperCase()} applicants with an open seat in their area</option>`;
    }
    $("inv-app").innerHTML = html;
  };
  $("inv-kind").addEventListener("change", fillApps);
  $("inv-seat").addEventListener("change", fillApps);
  fillApps();
  const call = async (url, body, statusId) => {
    if (preview) { $(statusId).textContent = "Preview: nothing is sent or changed."; return; }
    $(statusId).textContent = "Working…";
    const token = (await supa.auth.getSession()).data.session?.access_token;
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $(statusId).textContent = j.error ?? "Failed."; return; }
    await loadReal();
    section = "seats"; render();
    $(statusId).textContent = j.note ?? (j.publicId ? `Released ${j.seat}. ${j.publicId} is retired${j.banned ? " and blocked from signing in" : ""}.` : `Done.`);
  };
  inv.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!inv.reportValidity()) return;
    const kind = $("inv-kind").value;
    call("/api/admin/invites", { kind, seat: kind === "seat" ? $("inv-seat").value : undefined, applicationId: $("inv-app").value, hours: Number($("inv-hours").value) }, "inv-status");
  });
  $("rel-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("rel-form").reportValidity()) return;
    if (!confirm(`Release ${$("rel-seat").value}? The holder loses access and their public ID is retired. This is recorded in the seat history and can't be undone.`)) return;
    call("/api/admin/release", { seat: $("rel-seat").value, reason: $("rel-reason").value.trim() }, "rel-status");
  });
  $("ops-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("ops-seat") || !$("ops-form").reportValidity()) return;
    if (!confirm(`Appoint ${$("ops-email").value.trim()} to ${$("ops-seat").value}? The address is locked to this seat and can never become BinchikAdmin.`)) return;
    call("/api/admin/ops", { seat: $("ops-seat").value, email: $("ops-email").value.trim() }, "ops-status");
  });
  document.querySelectorAll("[data-revoke]").forEach((btn) => btn.addEventListener("click", () => {
    if (!confirm("Revoke this unused code? The applicant becomes eligible again.")) return;
    call("/api/admin/revoke", { offerId: btn.dataset.revoke }, "revoke-status");
  }));
}
function hierarchyView() {
  const W = 1000, colW = W / regions.length, H = 166 + Math.max(...regions.map((r) => r.states.length)) * 26 + 6;
  const l = lens();
  const myRegion = l ? (l.region_id ?? regionOf(l.state_iso)?.id) : null;
  const node = (x, y, w, label, sub, mine) => `<g class="node${mine ? " me" : ""}"><rect x="${x - w / 2}" y="${y - 15}" width="${w}" height="${sub ? 34 : 26}" rx="9"/><text x="${x}" y="${y + 2}" text-anchor="middle">${esc(label)}</text>${sub ? `<text class="sub" x="${x}" y="${y + 14}" text-anchor="middle">${esc(sub)}</text>` : ""}</g>`;
  // Top: the single BinchikAdmin (locked address). Then exactly three OpsAdmin seats. Roles never change.
  const opsX = [W / 2 - 150, W / 2, W / 2 + 150];
  let edges = opsX.map((x) => `<path class="edge" d="M${W / 2} 41 C ${W / 2} 46, ${x} 44, ${x} 51"/>`).join("");
  let nodes = node(W / 2, 22, 230, "BinchikAdmin · 1 seat", "locked address · approves", l?.role === "superadmin")
    + opsX.map((x, i) => node(x, 66, 130, `OPS-${i + 1}`, "OpsAdmin", l?.role === "admin" && (l?.ops_seat ? l.ops_seat === `OPS-${i + 1}` : i === 0))).join("");
  regions.forEach((r, i) => {
    const x = colW * i + colW / 2, mineR = myRegion === r.id;
    edges += `<path class="edge${mineR ? " me" : ""}" d="M${W / 2} 81 C ${W / 2} 96, ${x} 96, ${x} 108"/>`;
    nodes += node(x, 122, colW - 10, `${r.id} · 3 NRV`, r.name.length > 16 ? r.name.slice(0, 15) + "…" : r.name, mineR && l?.role === "nrv");
    r.states.forEach((iso, j) => { const y = 166 + j * 26, mineS = l?.state_iso === iso && l?.role === "szv"; edges += `<path class="edge${mineS ? " me" : ""}" d="M${x} ${j ? y - 24 : 139} V${y - 13}"/>`; nodes += node(x, y, colW - 18, `${stateName[iso]} · ${seats.filter((s) => s.role === "szv" && s.state_iso === iso).length || 3} SZV`, null, mineS); });
  });
  return `<h2>Hierarchy</h2><p class="muted">SZV → regional NRV → OpsAdmin (exactly three seats) → BinchikAdmin (one seat, locked to the owner's address). Roles never change: to change a holder, the seat is released and filled again. The highlighted path is the one in view.</p><div class="tree"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verifier hierarchy">${edges}${nodes}</svg></div>`;
}
function metricsView() {
  const f = flags.filter((x) => lensStates().includes(x.state_iso));
  return `<h2>Metrics</h2>
    <div class="kpis">${kpi("Seats filled", `${seats.filter((s) => s.taken).length}/${seats.length || 153}`, 2)}${kpi("Flags decided", `${f.filter((x) => ["approved", "rejected"].includes(x.status)).length}/${f.length}`, 4)}${kpi("Reports", nf.format(reports.length), 1)}${kpi("Escalations waiting", f.filter((x) => ["escalated", "ai_done"].includes(x.status)).length, 3)}</div>
    <h3>Monitoring plan</h3>
    <div class="metric-grid">
      <div class="panel"><b>Intake</b><ul><li>Reports per hour, by channel</li><li>Photo → reading time (median)</li><li>Share of fields needing a human read</li></ul></div>
      <div class="panel"><b>Results integrity</b><ul><li>Units at high / medium / low confidence</li><li>IReV mismatch rate, by state</li><li>Baseline breaches (register moved; votes above register)</li></ul></div>
      <div class="panel"><b>Verifier health</b><ul><li>Seats filled, and active in the last 24 h</li><li>Median time: flag → NRV review → decision</li><li>Flags per verifier (outliers can signal bias or pressure)</li><li>Approve : reject ratio, by region</li></ul></div>
      <div class="panel"><b>System</b><ul><li>Queue depth and retry rate</li><li>Ledger head age (minutes since the last entry)</li><li>Error rate per API route</li></ul></div>
    </div>`;
}
// Meeting invitees: a set of seat codes. Clicking a seat toggles it; clicking a state (or region) adds all its seats.
const picked = new Set();
const seatArea = (s) => (s.role === "szv" ? stateName[s.state_iso] : regions.find((r) => r.id === s.region_id)?.name ?? s.region_id);
const SIGNAL_GUIDE = `<details class="signal-guide"><summary>Set up Signal in five minutes (share this with verifiers)</summary><ol>
  <li>Install <strong>Signal</strong> from signal.org or your phone's official app store.</li>
  <li>Set your profile name to your <strong>seat number</strong> (for example SZV-073). Use no photo.</li>
  <li>Create a username: Settings → tap your profile → <strong>Username</strong>.</li>
  <li>Hide your number: Settings → Privacy → Phone number → set <strong>“Who can see my number”</strong> and <strong>“Who can find me by number”</strong> to <strong>Nobody</strong>.</li>
  <li>Join by tapping the <span class="mono">signal.link</span> call link in the invite email. Never share a phone number in a meeting.</li></ol>
  <p class="source-note">For the BinchikAdmin: in Signal, open Calls → <strong>Create a call link</strong>, turn on admin approval so only invited seats get in, and paste the link here. Menu names can differ slightly between app versions.</p></details>`;
function meetingsView() {
  return `<h2>Meetings</h2>
    <div class="callout signal-note"><strong>Default channel: Signal, by username only.</strong> Every verifier sets their Signal <strong>profile name to their seat number</strong> (for example SZV-073) and joins with a Signal username. <strong>Never share phone numbers</strong>, in a call, a group or a direct message. ${SIGNAL_GUIDE}</div>
    <form class="portal-form panel" id="meet-form">
    <div class="form-grid"><label class="wide">Title<input id="m-title" required maxlength="120" placeholder="Pre-election briefing"></label>
    <label>Date and time (WAT)<input id="m-when" type="datetime-local" required></label>
    <label>Channel<select id="m-channel"><option value="signal" selected>Signal call link (default)</option><option value="other">Other secure https link</option></select></label>
    <label class="wide">Meeting link<input id="m-link" type="url" required placeholder="https://signal.link/call/#key=…"></label>
    <label class="wide">Agenda (one item per line)<textarea id="m-agenda" rows="3"></textarea></label>
    <fieldset class="wide picker"><legend>Who to invite</legend>
      <div class="picked-box" aria-live="polite"><div class="picked-head"><b>Selected <span id="m-count">0</span></b><span class="muted" id="m-filled"></span></div><div id="m-picked"></div></div>
      <div class="picker-tools"><button class="btn btn-ghost btn-sm" type="button" data-all="szv">All SZVs</button><button class="btn btn-ghost btn-sm" type="button" data-all="nrv">All NRVs</button><button class="btn btn-ghost btn-sm" type="button" id="m-clear">Clear</button>
        <label class="sr-only" for="m-filter">Filter states and regions</label><input class="pick" id="m-filter" type="search" placeholder="Filter: state or region"></div>
      <p class="source-note">Click a seat to add it; click it again (or in Selected) to remove it. Click a state to add all three of its SZVs, or a region to add its three NRVs. One person is fine.</p>
      <div class="pick-groups" id="m-groups"></div>
    </fieldset></div>
    <div class="cta-row"><button class="btn btn-ghost btn-sm" type="button" id="m-dry">Count recipients</button><button class="btn btn-solid btn-sm" type="submit">Send invites</button></div>
    <p class="form-status" id="m-status" role="status"></p></form>`;
}
function drawPicker() {
  const q = ($("m-filter")?.value ?? "").trim().toLowerCase();
  const groups = [
    ...regions.map((r) => ({ key: `nrv:${r.id}`, title: `${r.id} ${r.name} · NRV`, list: seats.filter((s) => s.role === "nrv" && s.region_id === r.id) })),
    ...[...meta.states].sort((a, b) => a.name.localeCompare(b.name)).map((st) => ({ key: `szv:${st.iso}`, title: `${st.name} · SZV`, list: seats.filter((s) => s.role === "szv" && s.state_iso === st.iso) })),
  ].filter((g) => g.list.length && (!q || g.title.toLowerCase().includes(q)));
  $("m-groups").innerHTML = groups.length ? groups.map((g) => {
    const all = g.list.every((s) => picked.has(s.code));
    return `<div class="pick-group"><button type="button" class="pick-area" data-area="${g.key}" aria-pressed="${all}">${esc(g.title)}<small>${all ? "remove all" : `add all ${g.list.length}`}</small></button><div>${g.list.map((s) => `<button type="button" class="pick-seat${s.taken ? "" : " open"}" data-seat="${s.code}" aria-pressed="${picked.has(s.code)}" title="${s.taken ? "Filled" : "Open seat: no one to invite yet"}">${esc(s.code)}</button>`).join("")}</div></div>`;
  }).join("") : `<p class="muted">${seats.length ? "No state or region matches." : "The seat list could not be loaded."}</p>`;
  const chosen = seats.filter((s) => picked.has(s.code));
  $("m-count").textContent = chosen.length;
  $("m-filled").textContent = chosen.length ? `${chosen.filter((s) => s.taken).length} filled (only filled seats receive the invite)` : "";
  $("m-picked").innerHTML = chosen.length ? chosen.map((s) => `<button type="button" class="picked-chip" data-unpick="${s.code}" aria-label="Remove ${s.code}">${esc(s.code)} <span class="muted">${esc(seatArea(s))}</span> <span aria-hidden="true">×</span></button>`).join("") : `<span class="muted">No one yet. Pick seats below.</span>`;
}
function viewAsView() {
  return `<h2>View as…</h2><p class="muted">See exactly what a regional or state verifier sees. It is read-only: nothing can be changed from here, and verifiers are told in the rule book that the BinchikAdmin can view any dashboard. That keeps it oversight, not micromanagement.</p>
    <form class="portal-form panel" id="viewas-form"><div class="form-grid"><label>Role<select id="va-role"><option value="nrv">Regional Verifier (NRV)</option><option value="szv">State Zone Verifier (SZV)</option></select></label>
    <label>Area<select id="va-area"></select></label></div><button class="btn btn-solid btn-sm" type="submit">Open their view</button></form>`;
}
const rulebookView = () => `<h2>Rule book</h2><p>Your welcome packet and the full rule book address you only by your seat number.</p><a class="btn btn-solid" href="/portal/rulebook/${me?.seat_code ? `?seat=${encodeURIComponent(me.seat_code)}` : ""}">Open the rule book</a>`;
const VIEWS = { overview: overviewView, flags: flagsView, reports: reportsView, hierarchy: hierarchyView, seats: seatsView, metrics: metricsView, meetings: meetingsView, mail: mailView, contacts: crmView, viewas: viewAsView, rulebook: rulebookView, account: accountView };

function render() {
  drawSide();
  const main = $("cp-main");
  if (!me) { main.innerHTML = signInView(); wireSignIn(); return; }
  if (mfaNeeded) { main.innerHTML = mfaView(); mfaInto($("mfa-box"), async () => { mfaNeeded = false; await loadReal(); }); return; }
  $("viewas-banner").hidden = !viewAs;
  if (viewAs) $("viewas-banner").innerHTML = `Viewing as <strong>${viewAs.role.toUpperCase()}</strong> · ${esc(areaName(viewAs))} (read-only) <button class="btn btn-ghost btn-sm" type="button" id="va-exit">Back to my view</button>`;
  $("va-exit")?.addEventListener("click", () => { viewAs = null; section = "viewas"; render(); });
  main.innerHTML = (VIEWS[section] ?? overviewView)();
  main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b.dataset.act, b.dataset.id)));
  $("flag-form")?.addEventListener("submit", raiseFlag);
  main.querySelectorAll("[data-audit]").forEach((b) => b.addEventListener("click", () => auditReport(b.dataset.id, b.dataset.audit)));
  main.querySelectorAll("[data-review]").forEach((b) => b.addEventListener("click", () => openViewer(b.dataset.review)));
  main.querySelectorAll("[data-flagrow]").forEach((b) => b.addEventListener("click", () => flagFromRow(b.dataset.flagrow)));
  main.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => openViewer(b.dataset.view)));
  wireMeetings(); wireViewAs(); wireAccount(); wireSeatAdmin(); wireMail(); wireCrm();
}
function wireSignIn() {
  document.querySelectorAll("[data-prev]").forEach((b) => b.addEventListener("click", () => startPreview(b.dataset.prev)));
  $("pw-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("pw-status").textContent = "Signing in…";
    const { error } = await supa.auth.signInWithPassword({ email: $("si-email").value.trim(), password: $("si-pass").value });
    if (error) { $("pw-status").textContent = "That email and password didn't work. A seat becomes active only after its pledge is signed."; return; }
    await afterSignIn();
  });
  $("otp-btn")?.addEventListener("click", async () => {
    const email = $("si-email").value.trim();
    if (!email) { $("pw-status").textContent = "Enter your email first."; return; }
    $("pw-status").textContent = (await requestLink(email)).message;
  });
  $("reset-btn")?.addEventListener("click", async () => {
    const email = $("si-email").value.trim();
    if (!email) { $("pw-status").textContent = "Enter your email first, then choose “Forgot your password?”."; return; }
    $("pw-status").textContent = (await requestLink(email, true)).message;
  });
}
// Sign-in links come from Binchika's own endpoint (noreply@binchika.com, token-hash flow).
async function requestLink(email, reset = false) {
  const r = await fetch("/api/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, reset }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, message: r.ok ? `${j.message} Check your email.` : j.error ?? "Could not send a link. Please try again." };
}

// ---------- MFA (TOTP): required for OpsAdmin + BinchikAdmin, optional for verifiers ----------
const mfaView = () => `<h2>Verify it's you</h2><p>Your role (${esc(ROLE_LABEL[me.role])}) can change public records, so every sign-in needs a 6-digit code from an authenticator app, for example Google Authenticator, Microsoft Authenticator, 2FAS or Aegis.</p><div id="mfa-box" class="panel"><p class="muted">Loading…</p></div>`;
const codeForm = (label) => `<form class="portal-form" id="mfa-code-form"><label>6-digit code<input id="mfa-code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required class="code-input"></label><button class="btn btn-solid btn-sm" type="submit">${label}</button> <span class="form-status" id="mfa-status" role="status"></span></form>`;
async function mfaInto(box, done) {
  const { data: f } = await supa.auth.mfa.listFactors();
  const totp = (f?.all ?? []).filter((x) => x.factor_type === "totp");
  const verified = totp.find((x) => x.status === "verified");
  let factorId = verified?.id;
  if (!verified) {
    for (const x of totp) await supa.auth.mfa.unenroll({ factorId: x.id });   // clear abandoned set-ups
    const { data, error } = await supa.auth.mfa.enroll({ factorType: "totp", friendlyName: `Binchika ${new Date().toISOString().slice(0, 16)}` });
    if (error) { box.innerHTML = `<p class="callout">Could not start set-up: ${esc(error.message)}</p>`; return; }
    factorId = data.id;
    box.innerHTML = `<p><strong>Set up your authenticator app.</strong> Scan the QR code (or type the key), then enter the 6-digit code it shows.</p><div class="mfa-qr"><img id="mfa-img" alt="QR code to add Binchika to your authenticator app"><p class="source-note">Key: <code class="mono" style="word-break:break-all;user-select:all">${esc(data.totp.secret)}</code></p></div>${codeForm("Turn on and continue")}`;
    $("mfa-img").src = data.totp.qr_code;   // set via DOM: the SVG data URL contains quotes
  } else box.innerHTML = `<p>Open your authenticator app and enter the current code for Binchika.</p>${codeForm("Verify")}`;
  $("mfa-code-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await supa.auth.mfa.challengeAndVerify({ factorId, code: $("mfa-code").value.trim() });
    if (error) { $("mfa-status").textContent = "That code didn't work. Codes change every 30 seconds; try the current one."; return; }
    await done();
  });
}

// ---------- Account: password, MFA, sign out ----------
function accountView() {
  const isAdmin = ["admin", "superadmin"].includes(me.role);
  return `<h2>Settings and account</h2>${linkNotice ? `<p class="callout">${esc(linkNotice)}</p>` : ""}
    <div class="panel"><h3 style="margin-top:0">Sign in on another device</h3><p class="muted">We'll email a one-time sign-in link to your account address from noreply@binchika.com. Open it on the other device. ${isAdmin ? "You'll still be asked for your authenticator code." : ""}</p>
      <button class="btn btn-ghost btn-sm" type="button" id="link-me">Email me a fresh sign-in link</button> <span class="form-status" id="link-status" role="status"></span></div>
    <form class="portal-form panel" id="pw-change"><h3 style="margin-top:0">Set a new password</h3><div class="form-grid"><label>New password<input type="password" id="a-pass" autocomplete="new-password" minlength="12" maxlength="72" required></label><label>Repeat<input type="password" id="a-pass2" autocomplete="new-password" required></label></div>
      <button class="btn btn-solid btn-sm" type="submit">Save password</button> <span class="form-status" id="a-status" role="status"></span></form>
    <div class="panel"><h3 style="margin-top:0">Authenticator app (MFA)</h3><p class="muted" id="mfa-state">${isAdmin ? "Required for your role, and on: every sign-in asks for a 6-digit code." : "Optional for verifiers, and recommended."}</p>
      ${isAdmin || preview ? "" : `<button class="btn btn-ghost btn-sm" type="button" id="mfa-add">Add an authenticator app</button>`}<div id="mfa-box"></div></div>
    <div class="cta-row"><button class="btn btn-ghost btn-sm" type="button" id="sign-out">Sign out</button></div>`;
}
function wireAccount() {
  if (!$("pw-change")) return;
  $("pw-change").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p = $("a-pass").value, say = (t) => ($("a-status").textContent = t);
    if (p.length < 12) return say("Use at least 12 characters.");
    if (p !== $("a-pass2").value) return say("The two passwords don't match.");
    if (preview) return say("Preview: nothing saved.");
    const { error } = await supa.auth.updateUser({ password: p });
    say(error ? `Not saved: ${error.message}` : "Password saved.");
  });
  $("sign-out").addEventListener("click", async () => { if (!preview) await supa.auth.signOut(); location.href = "/portal/"; });
  $("link-me").addEventListener("click", async () => {
    if (preview) { $("link-status").textContent = "Preview: nothing is sent."; return; }
    const email = (await supa.auth.getUser()).data.user?.email;
    $("link-status").textContent = email ? (await requestLink(email)).message : "Not signed in.";
  });
  if (!preview && $("mfa-add")) {
    supa.auth.mfa.listFactors().then(({ data }) => { if ((data?.all ?? []).some((x) => x.factor_type === "totp" && x.status === "verified")) { $("mfa-state").textContent = "On: every sign-in asks for a 6-digit code."; $("mfa-add").remove(); } });
    $("mfa-add").addEventListener("click", () => { $("mfa-add").remove(); mfaInto($("mfa-box"), async () => { $("mfa-box").innerHTML = ""; $("mfa-state").textContent = "On: every sign-in asks for a 6-digit code."; }); });
  }
}
function wireViewAs() {
  const role = $("va-role"), area = $("va-area");
  if (!role) return;
  const fill = () => { area.innerHTML = role.value === "nrv" ? regions.map((r) => `<option value="${r.id}">${r.id} ${esc(r.name)}</option>`).join("") : [...meta.states].sort((a, b) => a.name.localeCompare(b.name)).map((s) => `<option value="${s.iso}">${esc(s.name)}</option>`).join(""); };
  fill();
  role.addEventListener("change", fill);
  $("viewas-form").addEventListener("submit", (e) => { e.preventDefault(); viewAs = role.value === "nrv" ? { role: "nrv", region_id: area.value } : { role: "szv", state_iso: area.value }; section = "overview"; render(); });
}
function wireMeetings() {
  const form = $("meet-form");
  if (!form) return;
  drawPicker();
  form.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.seat) picked.has(t.dataset.seat) ? picked.delete(t.dataset.seat) : picked.add(t.dataset.seat);
    else if (t.dataset.unpick) picked.delete(t.dataset.unpick);
    else if (t.dataset.area) {
      const [role, id] = t.dataset.area.split(":");
      const list = seats.filter((s) => s.role === role && (role === "szv" ? s.state_iso === id : s.region_id === id)).map((s) => s.code);
      const all = list.every((c) => picked.has(c));
      list.forEach((c) => (all ? picked.delete(c) : picked.add(c)));
    } else if (t.dataset.all) seats.filter((s) => s.role === t.dataset.all).forEach((s) => picked.add(s.code));
    else if (t.id === "m-clear") picked.clear();
    else return;
    drawPicker();
  });
  $("m-filter").addEventListener("input", drawPicker);
  const body = (dryRun) => ({ title: $("m-title").value, when: new Date($("m-when").value + ":00+01:00").toISOString(), link: $("m-link").value, channel: $("m-channel").value, agenda: $("m-agenda").value.split("\n").map((s) => s.trim()).filter(Boolean), audience: { seats: [...picked] }, dryRun });
  const send = async (dryRun) => {
    if (!form.reportValidity()) return;
    if (!picked.size) { $("m-status").textContent = "Choose at least one person to invite."; return; }
    if ($("m-channel").value === "signal" && !/^https:\/\/signal\.link\/call\//.test($("m-link").value)) { $("m-status").textContent = "A Signal call link starts with https://signal.link/call/ (or choose “Other secure https link”)."; return; }
    const b = body(dryRun);
    if (preview) {
      const n = b.audience.seats.length;
      $("m-status").textContent = dryRun ? `Preview: ${n} seat${n === 1 ? "" : "s"} selected: ${b.audience.seats.slice(0, 12).join(", ")}${n > 12 ? "…" : ""}.` : `Preview: ${n} invite${n === 1 ? "" : "s"} would be sent from noreply@binchika.com, each addressed by seat number.`;
      return;
    }
    const token = (await supa.auth.getSession()).data.session?.access_token;
    const r = await fetch("/api/admin/meetings", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(b) });
    const j = await r.json();
    $("m-status").textContent = !r.ok ? j.error : dryRun ? `${j.recipients} recipients: ${j.seats.slice(0, 12).join(", ")}${j.seats.length > 12 ? "…" : ""}` : `Sent ${j.sent} of ${j.recipients} invites.`;
  };
  $("m-dry").addEventListener("click", () => send(true));
  form.addEventListener("submit", (e) => { e.preventDefault(); send(false); });
}

// ---- Inbox & Sent (BinchikAdmin only) ----
// Incoming mail to ops@ / accounts@ / noreply@ is stored by the Email Worker workers/mailbox (a copy still goes to the
// owner's inbox); sending goes through /api/admin/mail/send (Resend, branded template). Guide: docs/EMAIL-GUIDE.md.
let mail = { tab: "in", mailbox: "all", list: [], unread: {}, mailboxes: [], open: null, html: false, loaded: false, loading: false, error: "", readError: "", notice: "", draft: null };
const MAILBOX_FALLBACK = [
  { key: "ops", address: "ops@binchika.com", name: "Binchika Ops", purpose: "verifiers, maintenance, technical and operational" },
  { key: "accounts", address: "accounts@binchika.com", name: "Binchika Accounts", purpose: "parties, manifestos, data requests" },
  { key: "noreply", address: "noreply@binchika.com", name: "Binchika", purpose: "announcements and notices (replies still arrive)" },
];
let previewMail = [];
// Tickets (session 78, phase 1, no AI): one per contact-form enquiry, reference BIN-YYMM-NNNN. Reference, topic,
// address, status and dates only; the requester's details stay in the Inbox message. docs/TICKETED-INQUIRIES-DESIGN.md
let tickets = { list: [], counts: {}, show: "open", loaded: false, loading: false, error: "", notice: "" };
let previewTickets = [];
const TICKET_STATUS = { new: "New", in_progress: "In progress", answered: "Answered", closed: "Closed" };
// Media access requests (session 91; functions/_lib/media.js): a checklist read on the server, three decisions, and a
// draft reply for each. The decision is recorded only when the reply is sent. "Registered media" is the register.
const MEDIA_DECISION = { approved: "Approve", more_info: "Ask for more", declined: "Decline" };
const MEDIA_DONE = { approved: "Registered", more_info: "More information asked", declined: "Declined" };
const MEDIA_CHECK = { request: "Request fields present", website: "Organisation website (https)", domain: "Email at the organisation's domain", terms: "Terms of use accepted", type: "Type of organisation given", use: "Intended use given", registration: "Registration number given", resolves: "Website domain resolves (DNS)", mx: "Email domain receives mail (MX)" };
const openTickets = () => (tickets.counts.new ?? 0) + (tickets.counts.in_progress ?? 0);
const mailBoxes = () => (mail.mailboxes.length ? mail.mailboxes : MAILBOX_FALLBACK);
const mailUnread = () => Object.values(mail.unread).reduce((a, n) => a + n, 0);
const authHeader = async () => ({ Authorization: `Bearer ${(await supa.auth.getSession()).data.session?.access_token}` });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

async function loadMail() {
  if (preview) {
    mail.unread = {};
    for (const m of previewMail) if (m.direction === "in" && !m.read_at) mail.unread[m.mailbox] = (mail.unread[m.mailbox] ?? 0) + 1;
    mail.list = previewMail.filter((m) => m.direction === mail.tab && (mail.mailbox === "all" || m.mailbox === mail.mailbox)).map((m) => ({ ...m, snippet: m.body_text.slice(0, 160), attachments: m.attachments.length }));
    mail.loaded = true;
    return;
  }
  try {
    const q = new URLSearchParams({ box: mail.tab === "out" ? "out" : "in", mailbox: mail.mailbox });
    const r = await fetch(`/api/admin/mail?${q}`, { headers: await authHeader() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    Object.assign(mail, { list: j.messages, unread: j.unread, mailboxes: j.mailboxes, error: "" });
  } catch (e) { mail.error = e.message || "The mailbox could not be loaded."; }
  mail.loaded = true;
}

function mailView() {
  const tabs = [["in", `Inbox${mailUnread() ? ` (${mailUnread()})` : ""}`], ["out", "Sent"], ["compose", "Compose"], ["tickets", `Tickets${openTickets() ? ` (${openTickets()} open)` : ""}`]];
  const head = `<h2>Inbox &amp; Sent</h2>
    <div class="mail-bar"><div class="seg" role="group" aria-label="Mailbox view">${tabs.map(([k, l]) => `<button type="button" data-mtab="${k}" aria-pressed="${mail.tab === k}">${l}</button>`).join("")}</div>
    ${mail.tab === "compose" ? "" : mail.tab === "tickets" ? `<button class="btn btn-ghost btn-sm" type="button" id="tk-refresh">Refresh</button>` : `<label class="mail-filter">Address <select id="mail-box"><option value="all">All three</option>${mailBoxes().map((b) => `<option value="${b.key}"${mail.mailbox === b.key ? " selected" : ""}>${esc(b.address)}${mail.unread[b.key] ? ` (${mail.unread[b.key]} unread)` : ""}</option>`).join("")}</select></label>
    <button class="btn btn-ghost btn-sm" type="button" id="mail-refresh">Refresh</button>`}</div>`;
  if (mail.tab === "compose") return head + (mail.notice ? `<p class="callout">${esc(mail.notice)}</p>` : "") + composeView();
  if (mail.tab === "tickets") return head + ticketsView();
  if (!mail.loaded) return `${head}<p class="muted">Loading…</p>`;
  if (mail.error) return `${head}<p class="callout">${esc(mail.error)}</p>`;
  const out = mail.tab === "out";
  const items = mail.list.length
    ? `<ul class="mail-list">${mail.list.map((m) => `<li><button type="button" data-mail="${esc(m.id)}" class="${!out && !m.read_at ? "unread" : ""}"${mail.open?.id === m.id ? ' aria-current="true"' : ""}>
        <b>${esc(out ? `To: ${m.to_addrs.join(", ")}` : m.from_name || m.from_addr)}</b><span class="mail-subj">${esc(m.subject || "(no subject)")}</span>
        <span class="mail-snip">${esc(m.snippet ?? "")}</span><span class="mail-meta">${esc(m.mailbox ? `${m.mailbox}@` : "")} · ${watTime(m.at)}${m.attachments ? ` · ${plural(m.attachments, "attachment")}` : ""}${m.auto ? " · automatic reply" : ""}${m.optout_confirm ? " · unsubscribe confirmation" : ""}</span>${optChip(m.optout)}</button></li>`).join("")}</ul>`
    : `<p class="muted">${out ? "Nothing sent from the dashboard yet. Automatic replies to incoming mail are listed here too; other emails the site sends by itself (seat codes, sign-in links, meeting invites) are not." : "No messages yet. Mail to ops@, accounts@ and noreply@binchika.com appears here once it reaches the mailbox; a copy also goes to the owner's own inbox."}</p>`;
  const openOpt = out ? 0 : mail.list.filter((m) => m.optout?.state === "open").length;
  return `${head}${mail.notice ? `<p class="callout">${esc(mail.notice)}</p>` : ""}${openOpt ? `<p class="callout" role="status"><b>${plural(openOpt, "opt-out request")} ${openOpt === 1 ? "needs" : "need"} your decision.</b> Open ${openOpt === 1 ? "it" : "each"} and choose “Remove from contacts and confirm”. Requests the mailbox could check are handled automatically and listed under Contacts &amp; campaigns → Opt-outs.</p>` : ""}<div class="mail-split"><div class="mail-col">${items}</div><div class="mail-read panel" id="mail-read">${readView()}</div></div>`;
}

// Session 96: opt-out requests in the Inbox. "open" = reads like UNSUBSCRIBE but nothing recorded yet; "done" = handled.
const optChip = (o) => (o?.state === "open" ? `<span class="chip warn"><i></i>Opt-out request · needs action</span>` : o?.state === "done" ? `<span class="chip ok"><i></i>Opt-out handled</span>` : "");
function optBox(m) {
  const o = m.optout;
  if (!o) return "";
  if (o.state === "done") return `<p class="callout" role="status"><b>Opt-out handled</b> ${watTime(o.at)} (${esc(OPT_METHOD[o.method] ?? o.method)}). The sender was removed from the contact registry and every campaign${o.confirmed === false ? "; the confirmation email could not be sent" : " and sent the confirmation from noreply@"}.</p>`;
  return `<div class="callout"><b>This looks like an opt-out request.</b> The mailbox did not act on it by itself (for example the message failed its sender checks). If it is genuine: <button class="btn btn-solid btn-sm" type="button" id="mail-optout">Remove from contacts and confirm</button></div>`;
}

function readView() {
  if (mail.readError) return `<p class="callout">${esc(mail.readError)}</p>`;
  const m = mail.open;
  if (!m) return `<p class="muted">Choose a message to read it.</p>`;
  // Incoming files download from the raw message kept in R2; for sent mail only the names and sizes are kept.
  const att = (m.attachments ?? []).map((a, i) => (m.direction === "in" ? `<button type="button" class="linklike" data-att="${i}">${esc(a.filename)} (${fmtSize(a.size)})</button>` : `${esc(a.filename)} (${fmtSize(a.size)})`)).join(" · ");
  return `<h3 class="mail-title">${esc(m.subject || "(no subject)")}</h3>
    <dl class="mail-hdr"><dt>From</dt><dd>${esc(m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr)}</dd><dt>To</dt><dd>${esc(m.to_addrs.join(", "))}</dd>${m.cc_addrs?.length ? `<dt>Cc</dt><dd>${esc(m.cc_addrs.join(", "))}</dd>` : ""}<dt>Date</dt><dd>${watTime(m.at)}</dd>${att ? `<dt>Files</dt><dd>${att}</dd>` : ""}</dl>${m.sent_by === "auto-reply" ? `<p class="source-note">Automatic reply, sent by the mailbox when their message arrived (at most once a day per sender).</p>` : ""}${optBox(m)}
    <div class="cta-row">${m.direction === "in" ? `<button class="btn btn-solid btn-sm" type="button" id="mail-reply">Reply</button><button class="btn btn-ghost btn-sm" type="button" id="mail-unread">Mark unread</button>` : ""}${m.body_html ? `<button class="btn btn-ghost btn-sm" type="button" id="mail-fmt">${mail.html ? "Show plain text" : "Show formatted"}</button>` : ""}<button class="btn btn-ghost btn-sm mail-del" type="button" id="mail-delete">Delete</button></div>
    ${mail.html && m.body_html ? `<iframe class="mail-frame" sandbox="" title="Formatted message"></iframe><p class="source-note">Formatted view: scripts, forms and remote images are blocked.</p>` : `<div class="mail-body">${esc(m.body_text)}</div>`}
    <p class="form-status" id="mail-status" role="status"></p>`;
}

async function loadTickets() {
  if (preview) {
    tickets.counts = {};
    for (const t of previewTickets) tickets.counts[t.status] = (tickets.counts[t.status] ?? 0) + 1;
    tickets.list = previewTickets.map((t) => ({ ...t, overdue: !["answered", "closed"].includes(t.status) && t.due_at < new Date().toISOString() }));
    tickets.loaded = true;
    return;
  }
  try {
    const r = await fetch("/api/admin/tickets", { headers: await authHeader() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    Object.assign(tickets, { list: j.tickets, counts: j.counts, error: "" });
  } catch (e) { tickets.error = e.message || "The tickets could not be loaded."; }
  tickets.loaded = true;
}

function ticketsView() {
  if (!tickets.loaded) return `<p class="muted">Loading…</p>`;
  if (tickets.error) return `<p class="callout">${esc(tickets.error)}</p>`;
  const shows = [["open", "Open"], ["all", "All"], ...Object.entries(TICKET_STATUS), ["media", "Media access"], ["registered", "Registered media"]];
  const isMedia = (t) => t.nature === "media_access";
  const list = tickets.list.filter((t) => (tickets.show === "all" ? true : tickets.show === "open" ? ["new", "in_progress"].includes(t.status)
    : tickets.show === "media" ? isMedia(t) : tickets.show === "registered" ? isMedia(t) && t.media?.decision === "approved" : t.status === tickets.show));
  const day = (t) => (t ? new Date(t).toLocaleDateString("en-GB", { timeZone: TENANT.locale.timeZone, day: "numeric", month: "short" }) : "—");
  const rows = list.map((t) => `<tr>
      <td class="mono">${esc(t.ref)}</td><td>${esc(t.topic ?? t.nature)}</td><td>${esc(`${t.mailbox}@`)}</td>
      <td><label class="sr-only" for="tk-${esc(t.ref)}">Status of ${esc(t.ref)}</label><select id="tk-${esc(t.ref)}" data-tk="${esc(t.ref)}">${Object.entries(TICKET_STATUS).map(([k, l]) => `<option value="${k}"${t.status === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td>${watTime(t.created_at)}</td>
      <td>${t.overdue ? `<span class="chip bad"><i></i>Overdue · ${day(t.due_at)}</span>` : day(t.due_at)}</td>
      <td>${t.closed_at ? day(t.closed_at) : "—"}</td>
      <td>${t.owner_seat ? `<span class="mono">${esc(t.owner_seat)}</span>` : "—"}</td>
      <td>${t.media ? mediaCell(t) : t.kb && t.mail_id ? `<span title="${esc(`Matched words: ${t.kb.matched.join(", ")}`)}">${esc(t.kb.question)} · ${Math.round(t.kb.score * 100)}%</span><br><button type="button" class="linklike" data-tk-reply="${esc(t.ref)}">Reply with this</button>` : "—"}</td>
      <td>${t.mail_id ? `<button type="button" class="linklike" data-tk-open="${esc(t.mail_id)}">Open message</button>` : `<span class="muted">No Inbox copy</span>`}</td></tr>`).join("");
  return `${tickets.notice ? `<p class="callout">${esc(tickets.notice)}</p>` : ""}
    <p class="muted" style="max-width:70ch">Every contact-form enquiry gets a reference (shown to the sender and in the automatic reply). Due dates are two working days after arrival. Tickets hold no personal details: open the message to see who wrote. Where an approved answer from the <a href="/help/">help page</a> fits, it is suggested; "Reply with this" fills it in for you to check and send. Nothing is sent automatically. Media access requests show a checklist instead: open the message, then choose Approve, Ask for more or Decline to fill in the matching reply; the decision is recorded when you send it. Registrations lapse with the message after 12 months.</p>
    <div class="mail-bar"><div class="seg" role="group" aria-label="Which tickets">${shows.map(([k, l]) => `<button type="button" data-tk-show="${k}" aria-pressed="${tickets.show === k}">${l}${k === "open" && openTickets() ? ` (${openTickets()})` : ""}</button>`).join("")}</div></div>
    ${list.length ? `<div class="table-scroll" style="max-height:none"><table class="data"><thead><tr><th scope="col">Reference</th><th scope="col">Topic</th><th scope="col">Address</th><th scope="col">Status</th><th scope="col">Received</th><th scope="col">Due</th><th scope="col">Closed</th><th scope="col">Last changed by</th><th scope="col">Suggested answer or review</th><th scope="col"><span class="sr-only">Message</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">${tickets.list.length ? "No tickets in this view." : "No tickets yet. Each enquiry sent through the contact form appears here with its reference."}</p>`}
    <p class="form-status" id="tk-status" role="status"></p>`;
}

function mediaCell(t) {
  const md = t.media;
  const checks = md.checks ? Object.entries(md.checks) : [];
  const failed = checks.filter(([, ok]) => !ok).map(([k]) => MEDIA_CHECK[k]);
  const summary = md.checks
    ? `<span class="chip ${failed.length ? "warn" : "ok"}" title="${esc(checks.map(([k, ok]) => `${ok ? "✓" : "✗"} ${MEDIA_CHECK[k]}`).join("\n"))}"><i></i>Checks ${md.passed}/${md.of}</span>${failed.length ? `<br><span class="source-note">Missing: ${esc(failed.join("; "))}</span>` : ""}`
    : `<span class="muted">Checklist shown while the message is kept</span>`;
  const done = md.decision ? `<br><span class="chip ${md.decision === "approved" ? "ok" : md.decision === "declined" ? "bad" : "warn"}"><i></i>${MEDIA_DONE[md.decision]}</span>` : "";
  const acts = t.mail_id ? `<br>${Object.entries(MEDIA_DECISION).map(([d, l]) => `<button type="button" class="linklike" data-tk-media="${esc(t.ref)}" data-decision="${d}">${l}</button>`).join(" · ")}` : "";
  // Session 92: the neutral reason used by "Decline" (functions/_lib/media.js MEDIA_DECLINE_REASONS).
  const why = t.mail_id && md.declines ? `<br><label class="sr-only" for="tk-why-${esc(t.ref)}">Reason if declined, ${esc(t.ref)}</label><select id="tk-why-${esc(t.ref)}" data-tk-why="${esc(t.ref)}" style="max-width:16rem">${Object.entries(md.declines).map(([k, r]) => `<option value="${esc(k)}">${esc(r.label)}</option>`).join("")}</select>` : "";
  return summary + done + acts + why;
}

// Media decision (session 91): the draft reply for that decision goes into Compose, threaded under the request. The
// decision is recorded on the ticket only when the reply is sent.
async function replyWithMediaDecision(ref, decision) {
  const t = tickets.list.find((x) => x.ref === ref);
  if (!t?.media?.replies?.[decision] || !t.mail_id) return;
  const reason = decision === "declined" ? document.querySelector(`[data-tk-why="${CSS.escape(ref)}"]`)?.value : null;
  const body = reason && t.media.declines?.[reason] ? t.media.declines[reason].reply : t.media.replies[decision];
  let m;
  if (preview) m = previewMail.find((x) => x.id === t.mail_id);
  else {
    const r = await fetch(`/api/admin/mail/${encodeURIComponent(t.mail_id)}`, { headers: await authHeader() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("tk-status").textContent = j.error ?? `Could not open the message for ${ref} (${r.status}).`; return; }
    m = j.message;
  }
  mail.draft = { from: t.mailbox, to: m.from_addr, cc: "", subject: /^\s*re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body, replyToId: m.id, replyLabel: m.subject || "(no subject)", ticketRef: ref, mediaDecision: decision, mediaReason: reason };
  mail.tab = "compose";
  mail.notice = `Draft “${MEDIA_DECISION[decision]}” reply filled in for ${ref}. Check the request in the message first, edit the reply if needed, then press Send. Sending records the decision; nothing has been sent yet.`;
  render();
}

// "Reply with this" (session 80, knowledge base K1): the approved answer and the reference go into Compose as a threaded
// reply from the ticket's mailbox. A person reads, edits if needed and sends; sending marks the ticket answered.
async function replyWithAnswer(ref) {
  const t = tickets.list.find((x) => x.ref === ref);
  if (!t?.kb || !t.mail_id) return;
  let m;
  if (preview) m = previewMail.find((x) => x.id === t.mail_id);
  else {
    const r = await fetch(`/api/admin/mail/${encodeURIComponent(t.mail_id)}`, { headers: await authHeader() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { $("tk-status").textContent = j.error ?? `Could not open the message for ${ref} (${r.status}).`; return; }
    m = j.message;
  }
  mail.draft = { from: t.mailbox, to: m.from_addr, cc: "", subject: /^\s*re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body: t.kb.reply, replyToId: m.id, replyLabel: m.subject || "(no subject)", ticketRef: ref };
  mail.tab = "compose";
  mail.notice = `Approved answer “${t.kb.question}” filled in for ${ref}. Read it and change anything that does not fit this person's question, then press Send. Nothing has been sent yet.`;
  render();
}

async function setTicketStatus(ref, status) {
  tickets.notice = "";
  if (preview) {
    const t = previewTickets.find((x) => x.ref === ref);
    Object.assign(t, { status, owner_seat: "V0001", closed_at: status === "closed" ? new Date().toISOString() : null });
    tickets.notice = `Preview: ${ref} is now ${TICKET_STATUS[status].toLowerCase()} (nothing is saved in preview).`;
    await loadTickets(); render(); return;
  }
  const r = await fetch(`/api/admin/tickets/${encodeURIComponent(ref)}`, { method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) }, body: JSON.stringify({ status }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("tk-status").textContent = j.error ?? `Could not change ${ref} (${r.status}).`; return; }
  tickets.notice = `${ref} is now ${TICKET_STATUS[status].toLowerCase()}.`;
  tickets.loaded = false; render();
}

function composeView() {
  const d = mail.draft ?? {};
  return `<form class="portal-form panel" id="mail-form"><div class="form-grid">
    <label>From<select id="mc-from">${mailBoxes().map((b) => `<option value="${b.key}"${(d.from ?? "ops") === b.key ? " selected" : ""}>${esc(`${b.name} <${b.address}>`)}</option>`).join("")}</select></label>
    <p class="source-note" id="mc-purpose"></p>
    <label class="wide">To<input id="mc-to" required autocomplete="off" value="${esc(d.to ?? "")}" placeholder="name@example.org (separate several with commas)"></label>
    <label class="wide">Cc (optional)<input id="mc-cc" autocomplete="off" value="${esc(d.cc ?? "")}"></label>
    <label class="wide">Subject<input id="mc-subject" required maxlength="200" value="${esc(d.subject ?? "")}"></label>
    <label class="wide">Message<textarea id="mc-body" rows="10" required maxlength="20000">${esc(d.body ?? "")}</textarea></label></div>
    <div class="mail-attach"><label class="btn btn-ghost btn-sm" for="mc-files">Attach files</label><input id="mc-files" class="sr-only" type="file" multiple accept="${ATTACH_ACCEPT}">
      <span class="source-note">Photos and images are compressed automatically (longest side up to ${IMG_MAX_SIDE} px). PDF and Office files are already compressed and go as they are. Up to ${ATTACH_MAX_FILES} files, ${ATTACH_MAX_MB} MB in total.</span>
      <ul class="mail-att-list" id="mc-att-list">${attachList(d.attachments)}</ul></div>
    ${d.replyToId ? `<p class="source-note">Replying to “${esc(d.replyLabel)}”. The original is quoted under your message and the reply is threaded with it.</p>` : ""}
    <p class="source-note">Your text goes out inside the branded Binchika email (agogo logo, sign-off from the chosen address, INEC notice). Plain text only: leave a blank line between paragraphs, and https links become clickable. At most 10 recipients.</p>
    <div class="cta-row"><button class="btn btn-ghost btn-sm" type="button" id="mc-preview">Preview</button><button class="btn btn-solid btn-sm" type="submit">Send</button>${d.replyToId ? `<button class="btn btn-ghost btn-sm" type="button" id="mc-cancel">Cancel reply</button>` : ""}</div>
    <p class="form-status" id="mc-status" role="status"></p>
    <iframe class="mail-frame" id="mc-frame" sandbox="" title="Email preview" hidden></iframe></form>`;
}

const saveDraft = () => { if ($("mail-form")) mail.draft = { ...mail.draft, from: $("mc-from").value, to: $("mc-to").value, cc: $("mc-cc").value, subject: $("mc-subject").value, body: $("mc-body").value }; };
const reloadMail = () => { mail.loaded = false; mail.open = null; mail.readError = ""; render(); };

function wireMail() {
  const main = $("cp-main");
  if (!main.querySelector("[data-mtab]")) return;
  if (mail.tab !== "compose" && !mail.loaded && !mail.loading) {
    mail.loading = true;
    loadMail().then(() => { mail.loading = false; if (section === "mail") render(); else drawSide(); });
  }
  main.querySelectorAll("[data-mtab]").forEach((b) => b.addEventListener("click", () => { saveDraft(); mail.tab = b.dataset.mtab; mail.html = false; mail.notice = ""; tickets.notice = ""; if (mail.tab === "tickets") tickets.loaded = false; reloadMail(); }));
  if (mail.tab === "tickets" && !tickets.loaded && !tickets.loading) {
    tickets.loading = true;
    loadTickets().then(() => { tickets.loading = false; if (section === "mail" && mail.tab === "tickets") render(); });
  }
  $("tk-refresh")?.addEventListener("click", () => { tickets.notice = ""; tickets.loaded = false; render(); });
  main.querySelectorAll("[data-tk-show]").forEach((b) => b.addEventListener("click", () => { tickets.show = b.dataset.tkShow; render(); }));
  main.querySelectorAll("[data-tk]").forEach((sel) => sel.addEventListener("change", () => setTicketStatus(sel.dataset.tk, sel.value)));
  main.querySelectorAll("[data-tk-reply]").forEach((b) => b.addEventListener("click", () => replyWithAnswer(b.dataset.tkReply)));
  main.querySelectorAll("[data-tk-media]").forEach((b) => b.addEventListener("click", () => replyWithMediaDecision(b.dataset.tkMedia, b.dataset.decision)));
  main.querySelectorAll("[data-tk-open]").forEach((b) => b.addEventListener("click", () => { mail.tab = "in"; mail.loaded = false; openMail(b.dataset.tkOpen); }));
  $("mail-box")?.addEventListener("change", (e) => { mail.mailbox = e.target.value; reloadMail(); });
  $("mail-refresh")?.addEventListener("click", () => { mail.notice = ""; reloadMail(); });
  main.querySelectorAll("[data-mail]").forEach((b) => b.addEventListener("click", () => openMail(b.dataset.mail)));
  const frame = main.querySelector("#mail-read .mail-frame");
  if (frame) frame.srcdoc = mail.open.body_html;
  $("mail-fmt")?.addEventListener("click", () => { mail.html = !mail.html; render(); });
  $("mail-unread")?.addEventListener("click", markUnread);
  $("mail-delete")?.addEventListener("click", deleteOpenMail);
  $("mail-optout")?.addEventListener("click", actOnOptOut);
  $("mail-reply")?.addEventListener("click", () => {
    const m = mail.open;
    mail.draft = { from: m.mailbox ?? "ops", to: m.from_addr, cc: "", subject: /^\s*re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`, body: "", replyToId: m.id, replyLabel: m.subject || "(no subject)" };
    mail.tab = "compose"; render();
  });
  main.querySelectorAll("[data-att]").forEach((b) => b.addEventListener("click", () => downloadAttachment(Number(b.dataset.att))));
  if ($("mail-form")) wireCompose($("mail-form"));
}

async function openMail(id) {
  mail.html = false; mail.readError = "";
  if (preview) {
    mail.open = previewMail.find((m) => m.id === id);
    if (mail.open.direction === "in") mail.open.read_at ??= new Date().toISOString();
    await loadMail(); render(); return;
  }
  const r = await fetch(`/api/admin/mail/${encodeURIComponent(id)}`, { headers: await authHeader() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { mail.open = null; mail.readError = j.error ?? `Could not open the message (${r.status}).`; render(); return; }
  mail.open = j.message;
  const row = mail.list.find((m) => m.id === id);
  if (row && !row.read_at && j.message.direction === "in") { row.read_at = j.message.read_at ?? new Date().toISOString(); if (mail.unread[row.mailbox]) mail.unread[row.mailbox]--; }
  render();
}

async function markUnread() {
  const id = mail.open.id;
  if (preview) { previewMail.find((m) => m.id === id).read_at = null; reloadMail(); return; }
  const r = await fetch(`/api/admin/mail/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) }, body: JSON.stringify({ unread: true }) });
  if (r.ok) reloadMail(); else $("mail-status").textContent = (await r.json().catch(() => ({}))).error ?? "Could not mark it unread.";
}

// Delete removes the dashboard copy only (D1 row + raw message in R2). Mail already forwarded to the owner's inbox stays.
async function deleteOpenMail() {
  const m = mail.open;
  if (!confirm(`Delete “${m.subject || "(no subject)"}” from the dashboard?${m.direction === "in" ? " The copy already forwarded to your own inbox is not affected." : ""} This cannot be undone.`)) return;
  if (preview) { previewMail = previewMail.filter((x) => x.id !== m.id); mail.notice = "Preview: message removed (nothing is deleted in preview)."; reloadMail(); return; }
  const r = await fetch(`/api/admin/mail/${encodeURIComponent(m.id)}`, { method: "DELETE", headers: await authHeader() });
  if (!r.ok) { $("mail-status").textContent = (await r.json().catch(() => ({}))).error ?? `Could not delete it (${r.status}).`; return; }
  mail.notice = `Deleted “${m.subject || "(no subject)"}” from the dashboard.`;
  reloadMail();
}

// Inbox opt-out requests (session 96): act on one the mailbox Worker could not handle by itself.
async function actOnOptOut() {
  const m = mail.open;
  if (!confirm(`Remove ${m.from_addr} from the contact registry and every campaign, and send the automated confirmation from noreply@binchika.com?`)) return;
  if (preview) { m.optout = { state: "done", method: "admin", at: new Date().toISOString(), confirmed: true }; mail.notice = "Preview: opt-out recorded (nothing is saved or sent in preview)."; render(); return; }
  const r = await fetch("/api/admin/optouts", { method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) }, body: JSON.stringify({ mailId: m.id }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("mail-status").textContent = j.error ?? `Could not record the opt-out (${r.status}).`; return; }
  mail.notice = `${j.masked}: ${j.already ? "already opted out; nothing more was sent." : `removed${j.removed ? " from contacts and every campaign" : " (they were not in the contact registry)"}; ${j.confirmed ? "confirmation sent from noreply@." : "the confirmation could not be sent (daily limit or provider): the removal has taken effect."}`}`;
  crm.data = null;
  await openMail(m.id);
}

// ---- Contacts & campaigns (BinchikAdmin only, session 96; functions/_lib/campaigns.js; docs/EMAIL-GUIDE.md §5c) ----
// A private registry: nothing here is public. Campaign sends go one message per person with only their address in Bcc,
// plus one blind copy to the owner. Unsubscribe links and UNSUBSCRIBE replies remove a person everywhere automatically.
let crm = { tab: "contacts", data: null, loading: false, error: "", notice: "", edit: null, pick: "", preview: null, draft: { campaignId: "", from: "noreply", subject: "", body: "" } };
let previewCrm = null;
const OPT_METHOD = { link: "Unsubscribe link", reply: "Replied UNSUBSCRIBE", admin: "Removed from the Inbox" };
const SEND_STATUS = { sending: "Sending", sent: "Sent", partial: "Partly sent", failed: "Not sent" };

async function loadCrm() {
  if (preview) { crm.data = previewCrm; return; }
  try {
    const r = await fetch("/api/admin/contacts", { headers: await authHeader() });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    crm.data = j; crm.error = "";
  } catch (e) { crm.error = e.message || "The contacts could not be loaded."; }
}

async function crmCall(path, method, body) {
  if (preview) return { ok: false, j: { error: "Preview: nothing is saved or sent." } };
  const r = await fetch(path, { method, headers: { "content-type": "application/json", ...(await authHeader()) }, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
}

function crmView() {
  const d = crm.data;
  const tabs = [["contacts", `Contacts${d ? ` (${d.contacts.length})` : ""}`], ["campaigns", `Campaigns${d ? ` (${d.campaigns.length})` : ""}`], ["send", "Send"], ["optouts", `Opt-outs${d?.optOuts.length ? ` (${d.optOuts.length})` : ""}`]];
  const head = `<h2>Contacts &amp; campaigns</h2>
    <p class="muted" style="max-width:72ch">Private to the BinchikAdmin. Nothing here is shown publicly or to verifiers or OpsAdmins. Keep notes short and factual: the person can ask to see them.</p>
    <div class="mail-bar"><div class="seg" role="group" aria-label="Contacts view">${tabs.map(([k, l]) => `<button type="button" data-ctab="${k}" aria-pressed="${crm.tab === k}">${l}</button>`).join("")}</div><button class="btn btn-ghost btn-sm" type="button" id="crm-refresh">Refresh</button></div>
    ${crm.notice ? `<p class="callout" role="status">${esc(crm.notice)}</p>` : ""}`;
  if (!d && !crm.error) return `${head}<p class="muted">Loading…</p>`;
  if (crm.error) return `${head}<p class="callout">${esc(crm.error)}</p>`;
  return head + ({ contacts: crmContactsView, campaigns: crmCampaignsView, send: crmSendView, optouts: crmOptOutsView }[crm.tab] ?? crmContactsView)();
}

function crmContactsView() {
  const d = crm.data, e = crm.edit ? d.contacts.find((c) => c.id === crm.edit) : null;
  const campName = Object.fromEntries(d.campaigns.map((k) => [k.id, k.name]));
  const rows = d.contacts.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.organisation ?? "")}</td>
      <td>${c.campaigns.length ? c.campaigns.map((id) => `<span class="chip">${esc(campName[id] ?? "?")}</span>`).join(" ") : `<span class="muted">None</span>`}</td>
      <td style="white-space:normal;max-width:28ch">${esc(c.notes ?? "")}</td>
      <td><button type="button" class="linklike" data-c-edit="${esc(c.id)}">Edit<span class="sr-only"> ${esc(c.name)}</span></button> · <button type="button" class="linklike" data-c-del="${esc(c.id)}">Remove<span class="sr-only"> ${esc(c.name)}</span></button></td></tr>`).join("");
  return `<form class="portal-form panel" id="c-form" novalidate><h3 style="margin-top:0">${e ? `Edit ${esc(e.name)}` : "Add a contact"}</h3><div class="form-grid">
      <label>Name<input id="c-name" maxlength="120" required autocomplete="off" value="${esc(e?.name ?? "")}"></label>
      <label>Email<input id="c-email" type="email" maxlength="254" required autocomplete="off" value="${esc(e?.email ?? "")}"></label>
      <label>Organisation (optional)<input id="c-org" maxlength="160" autocomplete="off" value="${esc(e?.organisation ?? "")}"></label>
      <label class="wide">Notes (optional, private, at most 1,000 characters)<textarea id="c-notes" maxlength="1000" rows="2">${esc(e?.notes ?? "")}</textarea></label></div>
      <div class="cta-row"><button class="btn btn-solid btn-sm" type="submit">${e ? "Save changes" : "Add contact"}</button>${e ? `<button class="btn btn-ghost btn-sm" type="button" id="c-cancel">Cancel</button>` : ""}</div>
      <p class="form-status" id="c-status" role="status"></p></form>
    ${d.contacts.length ? `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">Contacts</caption><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Organisation</th><th scope="col">Campaigns</th><th scope="col">Notes</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">No contacts yet. Add the first one above, then put them in a campaign.</p>`}`;
}

function crmCampaignsView() {
  const d = crm.data, k = d.campaigns.find((x) => x.id === crm.pick);
  const list = d.campaigns.map((x) => `<tr><td><button type="button" class="linklike" data-k-pick="${esc(x.id)}"${crm.pick === x.id ? ' aria-current="true"' : ""}>${esc(x.name)}</button></td><td>${x.members}</td><td>${watTime(x.created_at)}</td>
      <td><button type="button" class="linklike" data-k-ren="${esc(x.id)}">Rename<span class="sr-only"> ${esc(x.name)}</span></button> · <button type="button" class="linklike" data-k-del="${esc(x.id)}">Delete<span class="sr-only"> ${esc(x.name)}</span></button></td></tr>`).join("");
  const members = k ? `<fieldset class="panel" style="margin-top:1rem"><legend><b>Who is in “${esc(k.name)}”</b></legend>
      ${d.contacts.length ? `<p class="muted">Tick to add, untick to remove. Changes save at once. A contact can be in more than one campaign.</p><ul style="list-style:none;padding:0;display:grid;gap:.4rem">${d.contacts.map((c) => `<li><label style="display:flex;gap:.6rem;align-items:center;min-height:44px"><input type="checkbox" data-k-mem="${esc(c.id)}"${c.campaigns.includes(k.id) ? " checked" : ""}> ${esc(c.name)} <span class="muted">${esc(c.email)}</span></label></li>`).join("")}</ul>` : `<p class="muted">Add contacts first.</p>`}
      <p class="form-status" id="k-mem-status" role="status"></p></fieldset>` : "";
  return `<form class="portal-form panel" id="k-form" novalidate><div class="form-grid"><label>New campaign name<input id="k-name" maxlength="80" required autocomplete="off" placeholder="e.g. Newsroom briefing, November"></label></div>
      <button class="btn btn-solid btn-sm" type="submit">Create campaign</button><p class="form-status" id="k-status" role="status"></p></form>
    ${d.campaigns.length ? `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">Campaigns</caption><thead><tr><th scope="col">Campaign (choose to edit members)</th><th scope="col">People</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${list}</tbody></table></div>` : `<p class="muted">No campaigns yet.</p>`}${members}`;
}

function crmSendView() {
  const d = crm.data, dr = crm.draft, p = crm.preview;
  const ready = d.sendReady !== false;
  const hist = d.sends.map((s) => `<tr><td>${watTime(s.at)}</td><td>${esc(s.campaign_name)}</td><td>${esc(s.subject)}</td><td>${esc(`${s.mailbox}@`)}</td><td>${s.accepted} of ${s.recipients}</td><td>${s.owner_copy ? "Yes" : "No"}</td><td>${esc(SEND_STATUS[s.status] ?? s.status)}</td><td class="mono">${esc(s.sent_by ?? "")}</td></tr>`).join("");
  return `${ready ? "" : `<p class="callout">Sending is switched off until the owner copy address and the unsubscribe key are set (docs/OWNER-ACTIONS.md). You can still preview.</p>`}
    <p class="muted" style="max-width:72ch">Each person gets their own copy with only their own address, in Bcc: no one sees anyone else. Every copy has its own unsubscribe link. A blind copy goes to the owner's inbox. At most ${d.limits?.perSend ?? 50} people per send and ${d.limits?.perDay ?? 50} campaign emails a day. Preview first; sending asks you to confirm the number of people.</p>
    <form class="portal-form panel" id="s-form" novalidate><div class="form-grid">
      <label>Campaign<select id="s-camp" required><option value="">Choose…</option>${d.campaigns.map((k) => `<option value="${esc(k.id)}"${dr.campaignId === k.id ? " selected" : ""}>${esc(k.name)} (${k.members})</option>`).join("")}</select></label>
      <label>From<select id="s-from">${mailBoxes().map((b) => `<option value="${b.key}"${dr.from === b.key ? " selected" : ""}>${esc(b.address)}</option>`).join("")}</select></label>
      <label class="wide">Subject<input id="s-subject" maxlength="200" required value="${esc(dr.subject)}"></label>
      <label class="wide">Message (plain text; a blank line starts a new paragraph)<textarea id="s-body" rows="9" maxlength="20000" required>${esc(dr.body)}</textarea></label></div>
      <div class="cta-row"><button class="btn btn-ghost btn-sm" type="button" id="s-preview">Preview</button></div>
      ${p ? `<div style="margin-top:1rem"><p><b>${esc(p.campaign)}</b>: ${peopleCount(p.recipients)} will each get their own copy from ${esc(p.from)}, by Bcc. The owner gets one blind copy.</p>
        <iframe class="mail-frame" sandbox="" title="Campaign preview" id="s-frame"></iframe>
        <label style="display:flex;gap:.6rem;align-items:center;margin-top:.8rem"><input type="checkbox" id="s-ok"> <span>I have checked the preview. Send to ${peopleCount(p.recipients)}.</span></label>
        <div class="cta-row"><button class="btn btn-solid btn-sm" type="submit" id="s-send"${ready ? "" : " disabled"}>Send to ${peopleCount(p.recipients)}</button></div></div>` : ""}
      <p class="form-status" id="s-status" role="status"></p></form>
    <h3>Recent sends</h3>${d.sends.length ? `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">Recent campaign sends</caption><thead><tr><th scope="col">When</th><th scope="col">Campaign</th><th scope="col">Subject</th><th scope="col">From</th><th scope="col">Accepted</th><th scope="col">Owner copy</th><th scope="col">Status</th><th scope="col">By</th></tr></thead><tbody>${hist}</tbody></table></div>` : `<p class="muted">Nothing sent yet.</p>`}`;
}

function crmOptOutsView() {
  const o = crm.data.optOuts;
  return `<p class="muted" style="max-width:72ch">People who asked to stop receiving emails. Each was removed from the contact registry and every campaign at once, and was sent one confirmation from noreply@binchika.com. Only a masked address is shown; a scrambled form of the full address is kept so they cannot be added again by mistake. Requests that arrive by email and need a decision are marked in the Inbox.</p>
    ${o.length ? `<div class="table-scroll" style="max-height:none"><table class="data"><caption class="sr-only">Opt-outs</caption><thead><tr><th scope="col">When</th><th scope="col">Address</th><th scope="col">How</th><th scope="col">Was in</th><th scope="col">Confirmation</th></tr></thead><tbody>${o.map((x) => `<tr><td>${watTime(x.at)}</td><td>${esc(x.email_masked)}</td><td>${esc(OPT_METHOD[x.method] ?? x.method)}${x.mail_id ? ` · <button type="button" class="linklike" data-o-open="${esc(x.mail_id)}">Open message</button>` : ""}</td><td>${x.campaigns.length ? x.campaigns.map((n) => esc(n)).join(", ") : `<span class="muted">No campaign</span>`}</td><td>${x.confirmed ? `<span class="chip ok"><i></i>Sent</span>` : `<span class="chip warn"><i></i>Not sent</span>`}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">No opt-outs yet.</p>`}`;
}

const peopleCount = (n) => `${n} ${n === 1 ? "person" : "people"}`;
const reloadCrm = (notice = "") => { crm.notice = notice; crm.data = null; render(); };
const saveCrmDraft = () => { if ($("s-form")) crm.draft = { campaignId: $("s-camp").value, from: $("s-from").value, subject: $("s-subject").value, body: $("s-body").value }; };

function wireCrm() {
  const main = $("cp-main");
  if (!main.querySelector("[data-ctab]")) return;
  if (!crm.data && !crm.error && !crm.loading) { crm.loading = true; loadCrm().then(() => { crm.loading = false; if (section === "contacts") render(); }); }
  main.querySelectorAll("[data-ctab]").forEach((b) => b.addEventListener("click", () => { saveCrmDraft(); crm.tab = b.dataset.ctab; crm.notice = ""; render(); }));
  $("crm-refresh")?.addEventListener("click", () => { saveCrmDraft(); crm.error = ""; reloadCrm(); });
  const status = (id, t) => { if ($(id)) $(id).textContent = t; };
  $("c-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: $("c-name").value, email: $("c-email").value, organisation: $("c-org").value, notes: $("c-notes").value };
    const r = await crmCall(crm.edit ? `/api/admin/contacts/${encodeURIComponent(crm.edit)}` : "/api/admin/contacts", "POST", body);
    if (!r.ok) return status("c-status", r.j.error ?? "Could not save.");
    const was = crm.edit; crm.edit = null; reloadCrm(was ? `Saved ${body.name}.` : `Added ${body.name}.`);
  });
  $("c-cancel")?.addEventListener("click", () => { crm.edit = null; render(); });
  main.querySelectorAll("[data-c-edit]").forEach((b) => b.addEventListener("click", () => { crm.edit = b.dataset.cEdit; crm.notice = ""; render(); $("c-name")?.focus(); }));
  main.querySelectorAll("[data-c-del]").forEach((b) => b.addEventListener("click", async () => {
    const c = crm.data.contacts.find((x) => x.id === b.dataset.cDel);
    if (!confirm(`Remove ${c.name} (${c.email}) from the contact registry and all campaigns? This cannot be undone.`)) return;
    const r = await crmCall(`/api/admin/contacts/${encodeURIComponent(c.id)}`, "DELETE");
    if (!r.ok) { crm.notice = r.j.error ?? "Could not remove."; return render(); }
    reloadCrm(`Removed ${c.name}.`);
  }));
  $("k-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("k-name").value;
    const r = await crmCall("/api/admin/campaigns", "POST", { name });
    if (!r.ok) return status("k-status", r.j.error ?? "Could not create it.");
    crm.pick = r.j.id; reloadCrm(`Created “${name}”. Tick the people who belong in it.`);
  });
  main.querySelectorAll("[data-k-pick]").forEach((b) => b.addEventListener("click", () => { crm.pick = b.dataset.kPick; crm.notice = ""; render(); }));
  main.querySelectorAll("[data-k-ren]").forEach((b) => b.addEventListener("click", async () => {
    const k = crm.data.campaigns.find((x) => x.id === b.dataset.kRen);
    const name = prompt("New name for the campaign", k.name);
    if (!name || name === k.name) return;
    const r = await crmCall(`/api/admin/campaigns/${encodeURIComponent(k.id)}`, "POST", { name });
    if (!r.ok) { crm.notice = r.j.error ?? "Could not rename it."; return render(); }
    reloadCrm(`Renamed to “${name}”.`);
  }));
  main.querySelectorAll("[data-k-del]").forEach((b) => b.addEventListener("click", async () => {
    const k = crm.data.campaigns.find((x) => x.id === b.dataset.kDel);
    if (!confirm(`Delete the campaign “${k.name}”? The contacts stay in the registry.`)) return;
    const r = await crmCall(`/api/admin/campaigns/${encodeURIComponent(k.id)}`, "DELETE");
    if (!r.ok) { crm.notice = r.j.error ?? "Could not delete it."; return render(); }
    if (crm.pick === k.id) crm.pick = "";
    reloadCrm(`Deleted “${k.name}”.`);
  }));
  main.querySelectorAll("[data-k-mem]").forEach((box) => box.addEventListener("change", async () => {
    const r = await crmCall(`/api/admin/campaigns/${encodeURIComponent(crm.pick)}`, "POST", box.checked ? { add: [box.dataset.kMem] } : { remove: [box.dataset.kMem] });
    if (!r.ok) { box.checked = !box.checked; return status("k-mem-status", r.j.error ?? "Could not change it."); }
    const c = crm.data.contacts.find((x) => x.id === box.dataset.kMem), k = crm.data.campaigns.find((x) => x.id === crm.pick);
    c.campaigns = box.checked ? [...c.campaigns, k.id] : c.campaigns.filter((id) => id !== k.id);
    k.members += box.checked ? 1 : -1;
    status("k-mem-status", `${box.checked ? "Added" : "Removed"} ${c.name}.`);
  }));
  main.querySelectorAll("[data-o-open]").forEach((b) => b.addEventListener("click", () => { section = "mail"; mail.tab = "in"; mail.loaded = false; openMail(b.dataset.oOpen); }));
  const frame = $("s-frame");
  if (frame && crm.preview) frame.srcdoc = crm.preview.preview;
  ["s-camp", "s-from", "s-subject", "s-body"].forEach((id) => $(id)?.addEventListener("input", () => { if (crm.preview) { crm.preview = null; if ($("s-send")) $("s-send").disabled = true; status("s-status", "You changed the message: preview again before sending."); } }));
  const payload = () => ({ campaignId: $("s-camp").value, from: $("s-from").value, subject: $("s-subject").value, body: $("s-body").value });
  $("s-preview")?.addEventListener("click", async () => {
    saveCrmDraft();
    if (preview) { crm.preview = { campaign: crm.data.campaigns.find((k) => k.id === $("s-camp").value)?.name ?? "(no campaign)", recipients: 2, from: "Binchika <noreply@binchika.com>", preview: `<p style="font:16px Arial">${esc($("s-body").value)}</p><p style="font:12px Arial;color:#555">Preview: each copy ends with the person's own unsubscribe link.</p>` }; return render(); }
    const r = await crmCall("/api/admin/campaigns/send", "POST", { ...payload(), dryRun: true });
    if (!r.ok) return status("s-status", r.j.error ?? "Could not build the preview.");
    crm.preview = r.j; render();
  });
  $("s-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!crm.preview) return status("s-status", "Preview first.");
    if (!$("s-ok").checked) return status("s-status", "Tick the box to confirm you have checked the preview.");
    $("s-send").disabled = true;
    status("s-status", "Sending…");
    const r = await crmCall("/api/admin/campaigns/send", "POST", { ...payload(), confirmCount: crm.preview.recipients });
    if (!r.ok) { $("s-send").disabled = false; return status("s-status", r.j.error ?? `Not sent (${r.status}).`); }
    crm.preview = null; crm.draft = { campaignId: "", from: "noreply", subject: "", body: "" };
    reloadCrm(`Sent “${r.j.campaign}”: ${r.j.accepted} of ${r.j.recipients} accepted by the email provider${r.j.ownerCopy ? "; the owner's blind copy is on its way" : "; the owner copy was not accepted"}.`);
  });
}

// ---- Compose attachments: images are re-encoded in the browser before upload; documents go as they are. ----
// Limits mirror functions/_lib/mailbox.js (MAX_ATTACHMENTS, MAX_ATTACH_BYTES, ATTACH_TYPES); the server checks again.
const ATTACH_MAX_FILES = 10, ATTACH_MAX_MB = 15, IMG_MAX_SIDE = 2000, IMG_MIN_BYTES = 200 * 1024;
const ATTACH_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx";
const ATTACH_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf|text\/(plain|csv)|application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))$/;
const EXT_TYPES = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((n ?? 0) / 1024))} kB`);
const attachList = (list = []) => list.map((a, i) => `<li><span>${esc(a.filename)}</span><span class="muted">${a.compressed ? `${fmtSize(a.originalSize)} → ${fmtSize(a.size)} (compressed)` : fmtSize(a.size)}</span><button type="button" class="linklike" data-unattach="${i}" aria-label="Remove ${esc(a.filename)}">Remove</button></li>`).join("");
const toBase64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] ?? ""); r.onerror = fail; r.readAsDataURL(blob); });

/**
 * Shrink a photo or image for email: longest side at most IMG_MAX_SIDE px. JPEG/WebP and opaque PNGs become JPEG at
 * quality 0.85; PNGs with transparency stay PNG. Small files, GIFs and HEIC (not decodable in most browsers) are left
 * alone, and the original is kept whenever the result would not be smaller.
 */
async function compressImage(file, type) {
  if (!/^image\/(jpeg|png|webp)$/.test(type) || file.size < IMG_MIN_BYTES) return null;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return null; }
  const k = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const canvas = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  let alpha = false;
  if (type === "image/png") { const px = ctx.getImageData(0, 0, w, h).data; for (let i = 3; i < px.length; i += 4) if (px[i] < 255) { alpha = true; break; } }
  const outType = alpha ? "image/png" : "image/jpeg";
  if (outType === "image/jpeg" && type === "image/png") { ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); }
  const blob = await new Promise((ok) => canvas.toBlob(ok, outType, 0.85));
  if (!blob || blob.size >= file.size) return null;
  return { blob, type: outType, rename: outType === "image/jpeg" && type !== "image/jpeg" };
}

async function addAttachments(files) {
  const st = $("mc-status");
  const list = (mail.draft.attachments ??= []);
  const notes = [];
  for (const f of files) {
    if (list.length >= ATTACH_MAX_FILES) { notes.push(`at most ${ATTACH_MAX_FILES} files`); break; }
    const ext = f.name.split(".").pop().toLowerCase();
    const type = ATTACH_TYPES.test(f.type) ? f.type : EXT_TYPES[ext] ?? f.type;
    if (!ATTACH_TYPES.test(type ?? "")) { notes.push(`${f.name}: this file type can't be attached`); continue; }
    st.textContent = `Preparing ${f.name}…`;
    const c = await compressImage(f, type);
    const filename = c?.rename ? f.name.replace(/\.[^.]+$/, "") + ".jpg" : f.name;
    const blob = c?.blob ?? f;
    list.push({ filename, contentType: c?.type ?? type, content: await toBase64(blob), size: blob.size, originalSize: f.size, compressed: Boolean(c) });
  }
  const total = list.reduce((a, x) => a + x.size, 0);
  if (total > ATTACH_MAX_MB * 1048576) notes.push(`attachments total ${fmtSize(total)}; the limit is ${ATTACH_MAX_MB} MB, so remove a file before sending`);
  st.textContent = notes.length ? notes.join(". ") + "." : `${list.length} file${list.length === 1 ? "" : "s"} attached (${fmtSize(total)}).`;
  $("mc-att-list").innerHTML = attachList(list);
}

async function downloadAttachment(i) {
  const a = mail.open.attachments[i];
  if (preview) { $("mail-status").textContent = `Preview: ${a.filename} would download here.`; return; }
  const r = await fetch(`/api/admin/mail/attachment?id=${encodeURIComponent(mail.open.id)}&n=${i}`, { headers: await authHeader() });
  if (!r.ok) { $("mail-status").textContent = (await r.json().catch(() => ({}))).error ?? "Download failed."; return; }
  const url = URL.createObjectURL(await r.blob());
  Object.assign(document.createElement("a"), { href: url, download: a.filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function wireCompose(form) {
  const purpose = () => { const b = mailBoxes().find((x) => x.key === $("mc-from").value); $("mc-purpose").textContent = b ? `Use for: ${b.purpose}.` : ""; };
  purpose();
  $("mc-from").addEventListener("change", purpose);
  $("mc-cancel")?.addEventListener("click", () => { mail.draft = null; render(); });
  mail.draft ??= {};
  $("mc-files").addEventListener("change", async (e) => { const files = [...e.target.files]; e.target.value = ""; await addAttachments(files); });
  $("mc-att-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-unattach]");
    if (!b) return;
    mail.draft.attachments.splice(Number(b.dataset.unattach), 1);
    $("mc-att-list").innerHTML = attachList(mail.draft.attachments);
  });
  const st = $("mc-status");
  const go = async (dryRun) => {
    if (!form.reportValidity()) return;
    saveDraft();
    const d = mail.draft, box = mailBoxes().find((b) => b.key === d.from);
    const files = d.attachments ?? [];
    const fileNote = files.length ? ` with ${files.length} attachment${files.length === 1 ? "" : "s"} (${fmtSize(files.reduce((a, x) => a + x.size, 0))})` : "";
    if (preview) { st.textContent = dryRun ? "Preview mode: once signed in, Preview shows the real branded email built by the server." : `Preview: nothing sent. A real send would go from ${box.address} to ${d.to}${fileNote}.`; return; }
    if (!dryRun && !confirm(`Send “${d.subject}” from ${box.address} to ${d.to}${d.cc ? ` (cc ${d.cc})` : ""}${fileNote}?`)) return;
    st.textContent = dryRun ? "Building the preview…" : "Sending…";
    // The preview does not need the file contents, only their names; the real send uploads them.
    const attachments = files.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content }));
    const r = await fetch("/api/admin/mail/send", { method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) }, body: JSON.stringify({ from: d.from, to: d.to, cc: d.cc, subject: d.subject, body: d.body, replyToId: d.replyToId, attachments, dryRun }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { st.textContent = j.error ?? `Failed (${r.status}). Nothing was sent.`; return; }
    if (dryRun) { const f = $("mc-frame"); f.hidden = false; f.srcdoc = j.preview; st.textContent = `This is what ${j.to.join(", ")} will receive from ${j.from}${j.attachments?.length ? `, with ${j.attachments.map((a) => a.filename).join(", ")} attached` : ""}. Nothing has been sent yet.`; return; }
    // A reply started from a ticket ("Reply with this") marks that ticket answered; a media decision reply records the
    // decision instead (session 91).
    let tkNote = "";
    if (d.ticketRef) {
      const tr = await fetch(`/api/admin/tickets/${encodeURIComponent(d.ticketRef)}`, { method: "POST", headers: { "content-type": "application/json", ...(await authHeader()) }, body: JSON.stringify(d.mediaDecision ? { decision: d.mediaDecision, ...(d.mediaReason ? { note: `Reason: ${d.mediaReason}` } : {}) } : { status: "answered" }) }).catch(() => null);
      tkNote = d.mediaDecision
        ? (tr?.ok ? ` ${d.ticketRef}: ${MEDIA_DONE[d.mediaDecision].toLowerCase()} is recorded.` : ` ${d.ticketRef}: the decision could not be recorded; change the status under Tickets.`)
        : (tr?.ok ? ` ${d.ticketRef} is marked answered.` : ` ${d.ticketRef} could not be marked answered; change it under Tickets.`);
      tickets.loaded = false;
    }
    mail.draft = null; mail.tab = "out"; mail.notice = `Sent from ${j.from} to ${j.to.join(", ")}${j.attachments ? ` with ${j.attachments} attachment${j.attachments === 1 ? "" : "s"}` : ""}.${tkNote}`; reloadMail();
  };
  $("mc-preview").addEventListener("click", () => go(true));
  form.addEventListener("submit", (e) => { e.preventDefault(); go(false); });
}

async function act(action, id) {
  const f = flags.find((x) => x.id === id);
  if (action === "escalated" || action === "dismissed") {
    const findings = document.querySelector(`[data-find="${id}"]`)?.value.trim();
    if (!findings || findings.length < 10) return alert("Please write your findings first (at least 10 characters).");
    if (preview) { Object.assign(f, { status: action, nrv_findings: findings, nrv_public_id: me.public_id }); return render(); }
    const { error } = await supa.from("discrepancy_flags").update({ status: action, nrv_findings: findings }).eq("id", id);
    if (error) return alert(error.message);
  } else if (action === "investigating") {
    if (preview) { Object.assign(f, { status: "investigating", ai_summary: "Queued: the AI re-investigation service is not connected yet." }); return render(); }
    const { error } = await supa.from("discrepancy_flags").update({ status: "investigating" }).eq("id", id);
    if (error) return alert(error.message);
  } else {
    const note = document.querySelector(`[data-note="${id}"]`)?.value.trim();
    if (!note || note.length < 10) return alert("Please write a decision note (at least 10 characters).");
    if (preview) { Object.assign(f, { status: action === "approve" ? "approved" : "rejected" }); render(); return alert(action === "approve" ? "Preview: a correction entry would now be appended to the public ledger." : "Preview: the flag would be rejected."); }
    const token = (await supa.auth.getSession()).data.session?.access_token;
    const r = await fetch("/api/admin/decide", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ flagId: id, decision: action, note }) });
    const j = await r.json();
    if (!r.ok) return alert(j.error);
    if (j.ledger) alert(`Correction written to the ledger as entry #${j.ledger.seq}.`);
  }
  await loadReal();
}
async function raiseFlag(e) {
  e.preventDefault();
  const row = { pu_code: $("f-pu").value.trim(), race: $("f-race").value, reason: $("f-reason").value.trim() };
  if (preview) { flags.unshift({ ...row, id: "p" + Date.now(), state_iso: stateOfPu(row.pu_code) ?? me.state_iso, status: "open", raised_by_public_id: me.public_id }); return render(); }
  const { error } = await supa.from("discrepancy_flags").insert(row);
  $("f-status").textContent = error ? (error.message.includes("row-level") ? "You can only flag units in your own state." : error.message) : "Flag raised. Your NRV can now see it.";
  if (!error) await loadReal();
}

function startPreview(role) {
  preview = true; viewAs = null; section = "overview";
  $("preview-banner").hidden = false;
  me = { role, public_id: { szv: "V0007", nrv: "V0042", admin: "V0002", superadmin: "V0001" }[role], seat_code: { szv: "SZV-073", nrv: "NRV-16" }[role] ?? null, state_iso: role === "szv" ? "NG-LA" : null, region_id: role === "nrv" ? "R6" : null };
  flags = [
    { id: "p1", pu_code: "24-09-05-012", race: "president", state_iso: "NG-LA", status: "open", reason: "IReV upload shows 442 for one party; 5 photos show 412.", raised_by_public_id: "V0007" },
    { id: "p2", pu_code: "24-03-11-004", race: "president", state_iso: "NG-LA", status: "escalated", reason: "Two SZVs disagree on whether the sheet was altered.", raised_by_public_id: "V0009", nrv_public_id: "V0042", nrv_findings: "Photos from 6 reporters agree; the IReV image is the outlier." },
    { id: "p3", pu_code: "30-14-02-021", race: "house", state_iso: "NG-OY", status: "ai_done", reason: "Accredited voters exceed the unit's register.", raised_by_public_id: "V0013", nrv_public_id: "V0042", ai_summary: "Re-read of 9 photos: accredited 611, register 590. Baseline breach confirmed." },
    { id: "p4", pu_code: "19-22-04-007", race: "president", state_iso: "NG-KN", status: "open", reason: "Party totals on the photo do not add up to total valid votes.", raised_by_public_id: "V0021" },
  ];
  reports = Array.from({ length: 14 }, (_, i) => ({ pu_code: ["24-09-05-012", "24-03-11-004", "30-14-02-021", "19-22-04-007"][i % 4], race: i % 3 ? "president" : "house", channel: ["telegram", "web", "whatsapp", "sms"][i % 4], status: ["ocr_pending", "needs_review", "verified"][i % 3], received_at: new Date(Date.now() - i * 840000).toISOString(), id: `p-rep-${i}`, evidence: i === 1 ? "board" : i === 6 ? "handwritten" : "ec8a", audit_status: i === 1 ? "pending" : i === 6 ? "approved" : null, audited_by: i === 6 ? "V0007" : null, has_media: i === 1 || i === 6 || i === 4,
    // Session 88 preview: readings with sheet totals, one machine proposal, and the unit's consensus and gates.
    tally: i % 3 === 0 ? null : { APC: 47, PDP: 37, LP: 32, NNPP: 8 }, controls: i % 3 === 0 ? null : { register: 480, accredited: 130, rejected: 5 }, balanced: i % 3 !== 0, problems: [],
    ocr: i === 4 ? { status: "proposed", confidence: 0.6, fields: [{ name: "parties", confidence: 0.97 }, { name: "rejected", confidence: 0.6 }], transcript: "APC 47  PDP 37  LP 32  NNPP 8  Rejected 5  Accredited 130  Register 480" } : null,
    unit: { status: i % 3 === 2 ? "high" : "medium", share: 1, reports: 2 + (i % 2), irev: i === 2 ? { match: false } : null, gates: { gates: [{ id: "polling-unit", pass: true }, { id: "consensus", pass: i % 3 === 2 }, { id: "human-or-confident", pass: true }, { id: "control-totals", pass: true }, { id: "baseline", pass: true }] } } }));
  seats = seats.map((s, i) => ({ ...s, taken: i % 3 === 0, pending: i % 7 === 1 }));
  const day = 86400000;
  const pm = (id, direction, mailbox, from_addr, from_name, to, subject, body_text, ago, read, attachments = []) => ({ id, direction, mailbox, from_addr, from_name, to_addrs: [to], cc_addrs: [], subject, body_text, body_html: null, at: new Date(Date.now() - ago * day).toISOString(), read_at: read ? new Date().toISOString() : null, attachments });
  previewMail = [
    pm("pm1", "in", "ops", "volunteer@example.org", "Example Volunteer", "ops@binchika.com", "Question about the SZV seat in Lagos", "Good afternoon,\n\nI applied for an SZV seat in Lagos last week. How long does screening usually take?\n\nThank you.", 0.1, false),
    pm("pm2", "in", "accounts", "secretariat@example.org", "Example Party Secretariat", "accounts@binchika.com", "Manifesto summary for the party page", "Please find our manifesto summary attached for the parties page.", 0.6, false, [{ filename: "manifesto-summary.pdf", mimeType: "application/pdf", size: 184320 }]),
    pm("pm3", "in", "noreply", "reader@example.org", null, "noreply@binchika.com", "Re: Your Binchika sign-in link", "The link expired before I could use it. Could you send another?", 1.4, true),
    pm("pm4", "out", "ops", "ops@binchika.com", "Binchika Ops", "volunteer@example.org", "Re: Question about the SZV seat in Lagos", "Screening takes about a week. You will hear from noreply@binchika.com if a seat is offered.\n\nBinchika Ops", 0.05, true),
    pm("pm5", "in", "ops", "desk@example.org", "Example Newsroom Desk", "ops@binchika.com", "[BIN-2611-0002 · Media access request (press feed)] We would like to show the citizen tally on our live page", "Reference: BIN-2611-0002\nNature: Media access request (press feed)\n\nMedia access request\nOrganisation: Example Newsroom\nWebsite: https://example.org\nType: Newspaper or online newsroom\nIntended use: Live results page or embed\nChecking the feed: About once a minute\nTerms accepted: yes\nEmail domain matches the website: yes\n\nWe would like to show the citizen tally on our live page.", 0.2, false),
  ];
  previewMail.push({ ...pm("pm6", "in", "noreply", "former@example.org", "Example Former Contact", "noreply@binchika.com", "Re: Newsroom briefing", "Unsubscribe\n\n> Earlier message quoted here.", 0.02, false), optout: { state: "open" } });
  mail = { ...mail, tab: "in", mailbox: "all", mailboxes: [], open: null, loaded: false, loading: false, error: "", notice: "", draft: null };
  const pc = (id, name, email, organisation, campaigns, notes = null) => ({ id, name, email, organisation, notes, campaigns, created_at: new Date(Date.now() - 3 * day).toISOString() });
  previewCrm = {
    contacts: [pc("pc1", "Example Desk Editor", "editor@example.org", "Example Newsroom", ["pk1"], "Met at the press briefing."), pc("pc2", "Example Observer", "observer@example.net", "Example Observer Group", ["pk1", "pk2"]), pc("pc3", "Example Researcher", "research@example.edu", null, [])],
    campaigns: [{ id: "pk1", name: "Newsroom briefing", members: 2, created_at: new Date(Date.now() - 2 * day).toISOString() }, { id: "pk2", name: "Observers", members: 1, created_at: new Date(Date.now() - day).toISOString() }],
    optOuts: [{ id: "po1", email_masked: "f***@example.org", method: "link", campaigns: ["Newsroom briefing"], mail_id: null, confirmed: 1, at: new Date(Date.now() - 0.5 * day).toISOString() }],
    sends: [{ id: "ps1", campaign_name: "Newsroom briefing", mailbox: "noreply", subject: "Briefing on 4 November", recipients: 3, accepted: 3, owner_copy: 1, status: "sent", sent_by: "V0001", at: new Date(Date.now() - 1.5 * day).toISOString() }],
    limits: { perSend: 50, perDay: 50 }, sendReady: true,
  };
  crm = { ...crm, tab: "contacts", data: null, error: "", notice: "", edit: null, pick: "", preview: null };
  previewTickets = [
    { ref: "BIN-2611-0001", mail_id: "pm2", nature: "manifesto", topic: "Party manifesto or motto submission", mailbox: "accounts", status: "new", owner_seat: null, due_at: new Date(Date.now() + 1.4 * day).toISOString(), created_at: new Date(Date.now() - 0.6 * day).toISOString(), closed_at: null },
    { ref: "BIN-2610-0007", mail_id: "pm1", nature: "verifier", topic: "Verifier question", mailbox: "ops", status: "in_progress", owner_seat: "V0001",
      kb: { id: "verifier-timeline", question: "When will verifiers be selected?", score: 1, matched: ["verif", "how long"], link: "/verifiers/#time-h", reply: "Hello,\n\nThank you for asking. (Preview: the approved answer from the help page appears here, word for word.)\n\nYour reference is BIN-2610-0007. If this does not answer your question, just reply and a person will help." }, due_at: new Date(Date.now() - 0.3 * day).toISOString(), created_at: new Date(Date.now() - 3 * day).toISOString(), closed_at: null },
    { ref: "BIN-2611-0002", mail_id: "pm5", nature: "media_access", topic: "Media access request (press feed)", mailbox: "ops", status: "new", owner_seat: null, kb: null,
      media: { decision: null, checks: { request: true, website: true, domain: true, terms: true, type: true, use: true }, passed: 6, of: 6, type: "newsroom", use: "live_page", polling: "minute",
        replies: { approved: "Hello,\n\n(Preview: the approval reply from functions/_lib/media.js appears here: how to connect, the terms and the 12-month registration.)\n\nYour reference is BIN-2611-0002.", more_info: "Hello,\n\n(Preview: the request for more information appears here.)\n\nYour reference is BIN-2611-0002.", declined: "Hello,\n\n(Preview: the decline reply appears here; the public feed stays open.)\n\nYour reference is BIN-2611-0002." },
        declines: { unconfirmed: { label: "Organisation not confirmed", reply: "Hello,\n\n(Preview: decline, reason: organisation not confirmed.)\n\nYour reference is BIN-2611-0002." }, not_media: { label: "Not a media, observer or research organisation", reply: "Hello,\n\n(Preview: decline, reason: not a media, observer or research organisation.)\n\nYour reference is BIN-2611-0002." } } },
      due_at: new Date(Date.now() + 1.8 * day).toISOString(), created_at: new Date(Date.now() - 0.2 * day).toISOString(), closed_at: null },
    { ref: "BIN-2610-0003", mail_id: null, nature: "technical", topic: "Website or technical issue", mailbox: "ops", status: "closed", owner_seat: "V0001", due_at: new Date(Date.now() - 5 * day).toISOString(), created_at: new Date(Date.now() - 7 * day).toISOString(), closed_at: new Date(Date.now() - 6 * day).toISOString() },
  ];
  tickets = { ...tickets, show: "open", loaded: false, loading: false, error: "", notice: "" };
  loadMail();   // preview only: fills the unread badge at once (no network)
  loadTickets();
  adminData = {
    invites: [{ id: "p-inv-1", kind: "szv", state_iso: "NG-LA", seat_code: null, status: "sent", window_hours: 24, expires_at: new Date(Date.now() + 0.6 * day).toISOString(), created_by_public_id: "V0001" }, { id: "p-inv-2", kind: "seat", seat_code: "NRV-17", status: "claimed", window_hours: 24, confirm_expires_at: new Date(Date.now() + 0.3 * day).toISOString(), created_by_public_id: "V0001" }],
    ops: [{ code: "OPS-1", label: "OpsAdmin seat 1", holder: "V0002" }, { code: "OPS-2", label: "OpsAdmin seat 2", holder: null }, { code: "OPS-3", label: "OpsAdmin seat 3", holder: null }],
    applications: [
      { id: "3f2a91c0-0000-4000-8000-000000000001", state_iso: "NG-LA", role_sought: "szv", score: 92, created_at: new Date(Date.now() - 9 * day).toISOString() },
      { id: "7b11e4d2-0000-4000-8000-000000000002", state_iso: "NG-LA", role_sought: "szv", score: 85, created_at: new Date(Date.now() - 8 * day).toISOString() },
      { id: "c9d07a55-0000-4000-8000-000000000003", state_iso: "NG-OY", role_sought: "nrv", score: 88, created_at: new Date(Date.now() - 7 * day).toISOString() },
    ],
    history: [
      { at: new Date(Date.now() - 1 * day).toISOString(), seat_code: "OPS-1", event: "appointed", public_id: "V0002", actor_public_id: "V0001" },
      { at: new Date(Date.now() - 2 * day).toISOString(), seat_code: "SZV-073", event: "pledged", public_id: "V0007", pledge_version: "P-2026-2" },
      { at: new Date(Date.now() - 3 * day).toISOString(), seat_code: "SZV-073", event: "claimed", public_id: "V0007" },
      { at: new Date(Date.now() - 3.2 * day).toISOString(), seat_code: "SZV-073", event: "invited", actor_public_id: "V0001" },
    ],
  };
  render();
}

async function loadReal() {
  const { data: rows } = await supa.from("verifier_flags_public").select("*").order("created_at", { ascending: false }).limit(200);
  flags = rows ?? [];
  const token = (await supa.auth.getSession()).data.session?.access_token;
  reports = (await fetch("/api/portal/reports", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}))).reports ?? [];
  if (me.role === "superadmin") {
    try { seats = (await fetch("/api/seats", { cache: "no-store" }).then((r) => r.json())).seats ?? seats; } catch {}
    const r = await fetch("/api/admin/invites", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
    if (r?.ok) adminData = await r.json();
    await loadMail();   // Inbox unread count for the side badge
    await loadTickets();   // open-ticket count on the Tickets button
  }
  render();
}

// After any sign-in (password, magic link or a restored session): load the verifier row, then MFA for admins.
async function afterSignIn() {
  const { data: { session } } = await supa.auth.getSession();
  if (!session) return render();
  const { data } = await supa.from("verifiers").select("role, public_id, seat_code, ops_seat, state_iso, region_id, active").eq("user_id", session.user.id).maybeSingle();
  if (!data?.active) {
    me = null; render();
    $("cp-main").insertAdjacentHTML("afterbegin", `<p class="callout">This account is not an active verifier${data ? " yet. If you have just claimed a seat, open the confirmation link in your email and sign the pledge first" : ""}.</p>`);
    return;
  }
  me = data;
  if (["admin", "superadmin"].includes(me.role)) {
    const { data: lvl } = await supa.auth.mfa.getAuthenticatorAssuranceLevel();
    mfaNeeded = lvl?.currentLevel !== "aal2";
  }
  if (mfaNeeded) return render();
  await loadReal();
}

seats = await seatsP;
if (cfg.signIn) {
  const { createClient } = await import("/assets/vendor/supabase.js");
  supa = createClient(cfg.supabaseUrl, cfg.publishableKey);
  // Binchika-sent sign-in link: /portal/#th=<token_hash>[&reset=1]. Verified here, then removed from the address bar.
  // A link pasted into an already-open portal tab only changes the fragment, so reload to handle it.
  addEventListener("hashchange", () => { if (/(^#|&)th=/.test(location.hash)) location.reload(); });
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get("th")) {
    history.replaceState(null, "", location.pathname);
    const { error } = await supa.auth.verifyOtp({ token_hash: h.get("th"), type: "magiclink" });
    if (error) linkNotice = "That sign-in link has been used or has expired. Request a new one below.";
    else if (h.get("reset")) { section = "account"; linkNotice = "You're signed in with a one-time link. Set a new password below."; }
  }
  await afterSignIn();
} else render();
const qp = new URLSearchParams(location.search).get("preview");
if (qp && ROLE_SECTIONS[qp]) startPreview(qp);
