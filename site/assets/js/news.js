// News reel: headlines + links only. Refreshes every 10 minutes while the page is open.
const reel = document.getElementById("news-reel");
const live = document.getElementById("news-live");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (iso) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

async function load() {
  try {
    const { items } = await fetch("/api/news").then((r) => r.json());
    if (!items.length) { reel.innerHTML = `<p class="muted">No election headlines in the latest feeds. Check back soon.</p>`; return; }
    reel.innerHTML = items.map((i) => `<article><span class="src">${esc(i.source)}</span><h3><a href="${esc(i.link)}" rel="noopener" target="_blank">${esc(i.title)}<span class="sr-only"> (opens in a new tab)</span></a></h3><span class="muted" style="font-size:.8rem">${ago(i.publishedAt)}</span></article>`).join("");
    live.hidden = false;
  } catch {
    reel.innerHTML = `<p class="muted">Headlines are unavailable right now.</p>`;
  }
}
if (reel) { load(); setInterval(load, 600000); }

// Registered-voter breakdown (official INEC 2023 register).
const sexEl = document.getElementById("dg-sex");
if (sexEl) {
  const d = await fetch("/data/demographics.json").then((r) => r.json());
  const nfm = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
  const bars = (rows, colours) => rows.map((r, i) => `<div class="road-row" style="grid-template-columns:3.6rem 1fr 3.6rem"><span>${r.label}</span><div class="road-bar" role="img" aria-label="${r.label}: ${r.pct}% (${nfm.format(r.n)})"><span style="width:${r.pct}%;background:${colours[i]}"></span></div><span class="mono">${r.pct}%</span></div>`).join("");
  sexEl.innerHTML = bars(d.sex, ["var(--signal)", "var(--accent)"]) + `<p class="source-note" style="margin-top:.4rem">of ${nfm.format(d.total)} registered (2023)</p>`;
  document.getElementById("dg-age").innerHTML = bars(d.age, ["var(--z-ne)", "var(--z-nc)", "var(--z-nw)", "var(--z-se)"]);
}
