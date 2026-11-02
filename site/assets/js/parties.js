// Party cards: one identical template for every party; shuffled per visit with an A–Z toggle.
const [data, logos, officials] = await Promise.all([
  fetch("/data/parties.json").then((r) => r.json()),
  fetch("/data/party-logos.json").then((r) => r.json()).catch(() => ({ manifest: {} })),
  fetch("/data/party-officials.json").then((r) => r.json()).catch(() => ({ parties: {} })),
]);
const ROLES = ["National Chairman", "National Secretary", "National Treasurer", "National Financial Secretary", "National Legal Adviser"];
const fetched = officials.fetchedAt ? new Date(officials.fetchedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
// Identical block for every party: same fields, same order, "Not listed by INEC" where INEC shows N/A.
function officialsBlock(p) {
  const o = officials.parties?.[p.acronym];
  if (!o || o.error) return `<details class="officials"><summary>Party officials</summary><p class="muted">Not yet retrieved from INEC.</p></details>`;
  const socials = o.socials?.length ? o.socials.map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(new URL(s.url).hostname.replace("www.", ""))}</a>`).join(" · ") : "None verified yet";
  return `<details class="officials"><summary>Party officials (INEC)</summary>
    <dl>${ROLES.map((r) => `<div><dt>${r.replace("National ", "")}</dt><dd>${esc(o[r] ?? "Not listed by INEC")}</dd></div>`).join("")}
      <div><dt>Secretariat</dt><dd>${esc(o["Secretariat Address"] ?? "Not listed by INEC")}</dd></div>
      <div><dt>Official social handles</dt><dd>${socials}</dd></div></dl>
    <p class="source-note" style="margin:.4rem 0 0"><a href="${esc(o.url)}" rel="noopener">INEC profile</a>, retrieved ${fetched}. Handles are shown only when the party's official website, as listed by INEC, links to them.</p></details>`;
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
    <p class="civic muted">Motto and manifesto summary appear here once the party submits them.${p.logo ? "" : " INEC has not published a logo for this party yet."}</p>
    ${officialsBlock(p)}
    <p class="status"><span class="dot" aria-hidden="true"></span>Manifesto: not yet received</p>
    <div class="card-links"><a href="${esc(officials.parties?.[p.acronym]?.url ?? data.sourceUrl)}" rel="noopener">INEC profile<span class="sr-only"> for ${esc(p.name)}</span></a><a href="/contact/?topic=manifesto&party=${encodeURIComponent(p.acronym)}#contact">Submit manifesto<span class="sr-only"> for ${esc(p.name)}</span></a></div>`;
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

function render(order) {
  const items = order === "az" ? [...parties].sort((a, b) => a.name.localeCompare(b.name)) : shuffle(parties);
  list.replaceChildren(...items.map(card));
  document.getElementById("order-note").textContent = order === "az" ? "Alphabetical by full name." : "Shuffled on every visit, so no party is always first.";
}

document.querySelectorAll("[data-order]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-order]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render(b.dataset.order);
}));
render("shuffle");
