// Runs wrangler with the Binchika Cloudflare account from .env (not the shell's other-project token).
// Usage: node scripts/wr.mjs <wrangler args…>     e.g. node scripts/wr.mjs pages deploy site --project-name binchika
import { spawnSync } from "node:child_process";
import { loadEnv } from "./lib/env.mjs";

const env = loadEnv();
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const r = spawnSync("npx", ["wrangler", ...process.argv.slice(2).map(quote)], { stdio: "inherit", shell: true, env });
process.exit(r.status ?? 1);
