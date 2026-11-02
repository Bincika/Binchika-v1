// Writes the empty public ledger index (genesis head) for the cycle.
// Usage: node scripts/ledger-init.mjs [cycle]
import { mkdir, writeFile } from "node:fs/promises";
import { genesis } from "../functions/_lib/ledger.js";

const cycle = process.argv[2] ?? "ng-2027";
const head = await genesis(cycle);
const index = { cycle, genesis: head, head, entries: [], updated: new Date().toISOString() };
await mkdir("site/data/ledger", { recursive: true });
await mkdir("ledger", { recursive: true });
await writeFile("site/data/ledger/index.json", JSON.stringify(index, null, 2));
await writeFile("ledger/index.json", JSON.stringify(index, null, 2));
console.log("ledger genesis", cycle, head);
