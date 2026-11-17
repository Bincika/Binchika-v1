import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json)
// Party cards: one identical template for every party; shuffled per visit with an A–Z toggle.
const [data, logos, officials, manifestos] = await Promise.all([
  fetch("/data/parties.json").then((r) => r.json()),
  fetch("/data/party-logos.json").then((r) => r.json()).catch(() => ({ manifest: {} })),
  fetch("/data/party-officials.json").then((r) => r.json()).catch(() => ({ parties: {} })),
  fetch("/data/party-manifestos.json").then((r) => r.json()).catch(() => ({ parties: {} })),
]);
const ROLES = ["National Chairman", "National Secretary", "National Treasurer", "National Financial Secretary", "National Legal Adviser"];
const fetched = officials.fetchedAt ? new Date(officials.fetchedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
// Identical block for every party: same fields, same order, "Not listed by EEC" where EEC shows N/A.
function officialsBlock(p) {
  const o = officials.parties?.[p.acronym];
  if (!o || o.error) return `<details class="officials"><summary>Party officials</summary><p class="muted">Not yet retrieved from ${TENANT.electoralBody.short}.</p></details>`;
  const socials = o.socials?.length ? o.socials.map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(new URL(s.url).hostname.replace("www.", ""))}</a>`).join(" · ") : "None verified yet";
  return `<details class="officials"><summary>Party officials (${TENANT.electoralBody.short})</summary>
    <dl>${ROLES.map((r) => `<div><dt>${r.replace("National ", "")}</dt><dd>${esc(o[r] ?? `Not listed by ${TENANT.electoralBody.short}`)}</dd></div>`).join("")}
      <div><dt>Secretariat</dt><dd>${esc(o["Secretariat Address"] ?? `Not listed by ${TENANT.electoralBody.short}`)}</dd></div>
      <div><dt>Official social handles</dt><dd>${socials}</dd></div></dl>
    <p class="source-note" style="margin:.4rem 0 0"><a href="${esc(o.url)}" rel="noopener">${TENANT.electoralBody.short} profile</a>, retrieved ${fetched}. Handles are shown only when the party's official website, as listed by ${TENANT.electoralBody.short}, links to them.</p></details>`;
}
const list = document.getElementById("cards");
document.getElementById("color-rule").textContent = data.colorRule;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

const parties = data.parties.map((p, i) => ({ ...p, slot: i + 1, color: data.palette[i], logo: logos.manifest?.[p.acronym] ?? null }));

function shuffle(a) {
  const b = [...a];
  const rnd = new Uint32Array(b.length);
  crypto.getRandomValues(rnd);
  for (let i = b.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

function card(p) {
  const li = document.createElement("li");
  li.className = "pcard";
  li.style.setProperty("--pc", p.color);
  const mark = p.logo
    ? `<picture><source srcset="${p.logo.webp}" type="image/webp"><img src="${p.logo.png}" alt="${esc(p.name)} logo" width="70" height="70" loading="lazy" decoding="async"></picture>`
    : `<span class="mono-mark" aria-hidden="true">${esc(p.acronym)}</span>`;
  li.innerHTML = `
    <div class="pcard-top">
      <div class="emboss">${mark}</div>
      <span class="swatch" title="Binchika colour slot ${p.slot}"><i></i>slot ${String(p.slot).padStart(2, "0")}</span>
    </div>
    <div><h3>${esc(p.name)}</h3><span class="acr">${esc(p.acronym)}</span></div>
    <p class="civic muted">The party's motto appears here once the party sends it.${p.logo ? "" : ` ${TENANT.electoralBody.short} has not published a logo for this party yet.`}</p>
    ${officialsBlock(p)}
    <p class="status"><span class="dot" aria-hidden="true"></span>Manifesto sent to us: not yet received</p>
    <p class="status status-next"><span class="dot" aria-hidden="true"></span><span>Published manifesto: ${manifestos.parties?.[p.acronym] ? `<a href="#manifesto-${esc(p.acronym.toLowerCase())}">read our summary<span class="sr-only"> for ${esc(p.name)}</span></a>` : manifestos.noDocument?.[p.acronym] ? `none found, <a href="#manifesto-${esc(p.acronym.toLowerCase())}">see what we checked<span class="sr-only"> for ${esc(p.name)}</span></a>` : "not yet summarised"}</span></p>
    <div class="card-links"><a href="${esc(officials.parties?.[p.acronym]?.url ?? data.sourceUrl)}" rel="noopener">${TENANT.electoralBody.short} profile<span class="sr-only"> for ${esc(p.name)}</span></a><a href="/contact/?topic=manifesto&party=${encodeURIComponent(p.acronym)}#contact">Submit manifesto<span class="sr-only"> for ${esc(p.name)}</span></a></div>`;
  if (!reduce) {
    li.addEventListener("pointermove", (e) => {
      const r = li.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      li.style.setProperty("--ry", `${(x - 0.5) * 7}deg`);
      li.style.setProperty("--rx", `${(0.5 - y) * 7}deg`);
      li.style.setProperty("--mx", `${x * 100}%`);
      li.style.setProperty("--my", `${y * 100}%`);
    });
    li.addEventListener("pointerleave", () => { li.style.setProperty("--rx", "0deg"); li.style.setProperty("--ry", "0deg"); });
  }
  return li;
}

// Manifesto summaries: one template for every party, closed by default, in the same order as the cards.
const cited = (i) => `<li>${esc(i.text)} <span class="msum-cite">(${i.url ? `<a href="${esc(i.url)}" rel="noopener">${esc(i.cite)}</a>` : esc(i.cite)})</span></li>`;
const citedList = (items) => `<ul>${items.map(cited).join("")}</ul>`;
function summaryBlock(p, m) {
  const d = m.document;
  return `<details class="msum" id="manifesto-${esc(p.acronym.toLowerCase())}">
    <summary><h3>${esc(p.name)} (${esc(p.acronym)})</h3></summary>
    <dl class="msum-facts">
      <div><dt>Document</dt><dd>${esc(d.title)}</dd></div>
      <div><dt>Published by</dt><dd>${esc(d.publisher)}</dd></div>
      <div><dt>Date</dt><dd>${esc(d.date)}</dd></div>
      <div><dt>Length</dt><dd>${esc(d.length)}</dd></div>
      <div><dt>Still current?</dt><dd>${esc(d.status)}</dd></div>
      <div><dt>Read it</dt><dd>${m.links.map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`).join(" · ")}<br><small class="msum-hash">${esc(m.fingerprint)}</small></dd></div>
    </dl>
    <h4>Key positions</h4>
    ${m.positions.map((t) => `<h5>${esc(t.topic)}</h5>${citedList(t.items)}`).join("")}
    <h4>Elections, technology and citizen participation</h4>
    ${m.elections.length ? citedList(m.elections) : ""}
    <p>${esc(m.notAddressed)}</p>
    <h4>Numbers, dates and costs</h4>
    <p>We ask the same three questions of every manifesto: does a claim state a number, a date and a cost? We report the answer. We do not judge whether a policy is good or affordable.</p>
    <h5>Stated with a measure</h5>
    ${citedList(m.withMeasure)}
    <h5>Stated without a measure, or unclear</h5>
    ${citedList(m.withoutMeasure)}
    <h4>Relevance to election integrity, open data and public accountability</h4>
    ${citedList(m.relevance)}
    <h4>Published since this document</h4>
    ${m.since.length ? `<p>These are not part of the document above.</p>${citedList(m.since)}` : `<p>We found nothing newer from the party as of ${esc(m.researched)}.</p>`}
    <p class="source-note">Researched ${esc(m.researched)}. ${esc(m.limits)}</p>
  </details>`;
}
// The same collapsed block, for a party whose manifesto we could not find.
function noDocumentBlock(p, m) {
  return `<details class="msum" id="manifesto-${esc(p.acronym.toLowerCase())}">
    <summary><h3>${esc(p.name)} (${esc(p.acronym)})</h3></summary>
    <p>${esc(m.statement)}</p>
    <h4>Sources checked</h4>
    <ul>${m.checked.map((c) => `<li>${c.url ? `<a href="${esc(c.url)}" rel="noopener">${esc(c.label)}</a>` : esc(c.label)}</li>`).join("")}</ul>
    <h4>What has been reported</h4>
    <p>These are not a manifesto.</p>
    ${citedList(m.reported)}
    <p class="source-note">Researched ${esc(m.researched)}. A party can send its manifesto through our contact form, and we will summarise it on the same template.</p>
  </details>`;
}
const summaries = document.getElementById("manifesto-list");
const openFromHash = () => {
  const el = /^#manifesto-[a-z0-9-]+$/.test(location.hash) ? document.getElementById(location.hash.slice(1)) : null;
  if (!el) return;
  el.open = true;
  el.scrollIntoView({ block: "start", behavior: "instant" }); // the block sits far below 22 cards: a smooth scroll does not arrive
};

function render(order) {
  const items = order === "az" ? [...parties].sort((a, b) => a.name.localeCompare(b.name)) : shuffle(parties);
  list.replaceChildren(...items.map(card));
  document.getElementById("order-note").textContent = order === "az" ? "Alphabetical by full name." : "Shuffled on every visit, so no party is always first.";
  const done = items.filter((p) => manifestos.parties?.[p.acronym]);
  const none = items.filter((p) => manifestos.noDocument?.[p.acronym]);
  summaries.innerHTML = items.map((p) => (manifestos.parties?.[p.acronym] ? summaryBlock(p, manifestos.parties[p.acronym]) : manifestos.noDocument?.[p.acronym] ? noDocumentBlock(p, manifestos.noDocument[p.acronym]) : "")).join("");
  document.getElementById("manifesto-count").textContent = `${done.length} of ${parties.length}`;
  const open = parties.length - done.length - none.length;
  document.getElementById("manifesto-rest").textContent = [none.length ? `For ${none.length} we found no complete document, and each block says what we checked.` : "", open ? `For ${open}, a filed copy is listed in the Internet Archive, but we have not been able to download it yet, so we have not summarised them.` : ""].filter(Boolean).join(" ");
}

document.querySelectorAll("[data-order]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-order]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render(b.dataset.order);
}));
render("shuffle");
window.addEventListener("hashchange", openFromHash);
openFromHash();
