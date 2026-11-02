// Scroll-lit sequences: a rail fills as you scroll and each step slides in and lights up when it reaches the
// middle of the screen. Any container marked [data-scroll-lit] gets it; items are its [data-lit-item] children
// (or common step elements). Respects prefers-reduced-motion (everything simply shown lit).

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
// GSAP is not needed for first paint: load it after the page has loaded (keeps DOMContentLoaded fast on mobile).
await new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", r, { once: true })));
const { gsap, ScrollTrigger } = reduce ? {} : await import("/assets/vendor/gsap.js");
const ITEM = "[data-lit-item], .glass-bar, .role, .flow > li, .timeline > li, .kpi, .pledge > div, .lit-step";

for (const box of document.querySelectorAll("[data-scroll-lit]")) {
  const items = [...box.querySelectorAll(ITEM)].filter((el) => el.closest("[data-scroll-lit]") === box);
  items.forEach((el) => el.classList.add("lit-item"));
  if (reduce) { items.forEach((el) => el.classList.add("is-lit")); continue; }

  const rail = document.createElement("div");
  rail.className = "lit-rail";
  rail.setAttribute("aria-hidden", "true");
  rail.innerHTML = "<i></i>";
  box.prepend(rail);
  ScrollTrigger.create({
    trigger: box, start: "top 70%", end: "bottom 55%",
    onUpdate: (self) => rail.style.setProperty("--p", self.progress.toFixed(3)),
  });

  items.forEach((el, i) => {
    const wide = innerWidth > 760; // phones: rise vertically so nothing pokes past the screen edge
    gsap.fromTo(el, wide ? { x: i % 2 ? 26 : -26, opacity: 0.4 } : { y: 22, opacity: 0.4 }, {
      x: 0, y: 0, opacity: 1, ease: "none",
      scrollTrigger: { trigger: el, start: "top 92%", end: "top 58%", scrub: 0.6 },
    });
    ScrollTrigger.create({ trigger: el, start: "top 62%", end: "bottom 38%", toggleClass: { targets: el, className: "is-lit" } });
  });
}
ScrollTrigger?.refresh();
