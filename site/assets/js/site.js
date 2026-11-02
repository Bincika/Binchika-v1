// Shared behaviour: nav, theme, local clock, reveal-on-scroll, countdowns, scroll-lit steps.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;

// nav
const menu = document.querySelector(".menu-btn");
const nav = document.getElementById("nav");
menu?.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("open", open);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && nav?.classList.contains("open")) { menu.click(); menu.focus(); } });

// theme: explicit choice persists; otherwise follow the system
const themeBtn = document.querySelector("[data-theme-toggle]");
const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
const labelTheme = () => themeBtn?.setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
labelTheme();
themeBtn?.addEventListener("click", () => {
  if (!reduce) { root.classList.add("theme-anim"); setTimeout(() => root.classList.remove("theme-anim"), 400); }
  root.dataset.theme = isDark() ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch {}
  labelTheme();
  dispatchEvent(new CustomEvent("themechange", { detail: root.dataset.theme }));
});

// local clock (configurable per country via /data/locale.json)
const clockEl = document.querySelector("[data-clock-time]");
const metaEl = document.querySelector("[data-clock-meta]");
fetch("/data/locale.json").then((r) => r.json()).catch(() => ({ timeZone: "Africa/Lagos", zoneLabel: "WAT", utcOffset: "UTC+1", city: "Abuja", locale: "en-GB" })).then((loc) => {
  const fmt = new Intl.DateTimeFormat(loc.locale, { timeZone: loc.timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const day = new Intl.DateTimeFormat(loc.locale, { timeZone: loc.timeZone, weekday: "short", day: "numeric", month: "short" });
  const draw = () => {
    const now = new Date();
    if (clockEl) clockEl.textContent = fmt.format(now);
    if (metaEl) metaEl.textContent = `${loc.city} · ${day.format(now)} · ${loc.zoneLabel}`;
  };
  draw();
  setInterval(draw, 1000);
  document.querySelector("[data-clock]")?.setAttribute("aria-label", `Local time in ${loc.city}, ${loc.zoneLabel} (${loc.utcOffset})`);
  window.binchikaLocale = loc;
});

// reveal
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
}, { rootMargin: "0px 0px -8% 0px" });
document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

// countdowns: <div data-countdown="2027-01-16T00:00:00+01:00">
const pad = (n) => String(n).padStart(2, "0");
const cds = [...document.querySelectorAll("[data-countdown]")];
function tick() {
  const now = Date.now();
  for (const el of cds) {
    let ms = Math.max(0, Date.parse(el.dataset.countdown) - now);
    const d = Math.floor(ms / 864e5); ms -= d * 864e5;
    const h = Math.floor(ms / 36e5); ms -= h * 36e5;
    const m = Math.floor(ms / 6e4); ms -= m * 6e4;
    const s = Math.floor(ms / 1e3);
    const set = (k, v) => { const n = el.querySelector(`[data-u="${k}"]`); if (n && n.textContent !== v) n.textContent = v; };
    set("d", String(d)); set("h", pad(h)); set("m", pad(m)); set("s", pad(s));
    const sr = el.querySelector("[data-sr]");
    if (sr && (s === 0 || !sr.textContent)) sr.textContent = `${d} days, ${h} hours and ${m} minutes to go`;
  }
}
if (cds.length) { tick(); setInterval(tick, 1000); }

// scroll-lit method steps
const steps = [...document.querySelectorAll(".step")];
const lampText = document.querySelector("[data-lamp]");
if (steps.length) {
  const spots = [["22%", "30%"], ["72%", "28%"], ["32%", "72%"], ["76%", "66%"], ["50%", "45%"]];
  const light = (i) => {
    steps.forEach((s, j) => s.classList.toggle("lit", j <= i));
    const lamp = lampText?.closest(".lamp");
    if (lamp) { lamp.style.setProperty("--lx", spots[i % spots.length][0]); lamp.style.setProperty("--ly", spots[i % spots.length][1]); }
    if (lampText) lampText.innerHTML = steps[i].dataset.lamp;
  };
  const so = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) light(steps.indexOf(e.target));
  }, { rootMargin: "-45% 0px -45% 0px" });
  steps.forEach((s) => so.observe(s));
}

// shared number formatting (UK English)
export const nf = new Intl.NumberFormat("en-GB");
