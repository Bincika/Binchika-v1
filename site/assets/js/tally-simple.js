// A plain, country-neutral view of the public tally: one table per race, read from /api/results. It never names a winner.
import { TENANT } from "./lib/tenant.generated.js";

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat(TENANT.locale.lang);
const races = (await fetch("/data/races.json").then((r) => r.json())).races;
const offered = Object.keys(races).filter((k) => k !== "local-government");
const box = $("tally-races");

async function show(race) {
  for (const b of box.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.race === race));
  const status = $("tally-status"), table = $("tally-table"), body = table.querySelector("tbody");
  status.textContent = "Loading…";
  let data = null;
  try { const r = await fetch(`/api/results?race=${encodeURIComponent(race)}`); if (r.ok) data = await r.json(); } catch { /* shown below */ }
  if (!data) { table.hidden = true; status.textContent = "The tally could not be loaded. Please try again shortly."; return; }
  const totals = Object.entries(data.national?.totals ?? {}).sort((a, b) => b[1] - a[1]);
  body.replaceChildren(...totals.map(([party, votes]) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th"); th.scope = "row"; th.textContent = party;
    const td = document.createElement("td"); td.className = "num"; td.textContent = nf.format(votes);
    tr.append(th, td);
    return tr;
  }));
  table.hidden = !totals.length;
  const reported = data.units?.reported ?? 0;
  status.textContent = `${nf.format(reported)} of ${nf.format(TENANT.pollingUnits.total)} polling stations reported. ${data.notice ?? TENANT.notice}`;
}

for (const key of offered) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.dataset.race = key; b.textContent = races[key].label;
  b.addEventListener("click", () => show(key));
  box.append(b);
}
await show(offered[0]);
