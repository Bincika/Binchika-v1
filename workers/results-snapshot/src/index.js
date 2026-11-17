// binchika-results-snapshot: once a minute, rebuild each race's public totals into one row, so a reader's request never scans.
// Deploy from the deploy worktree: node scripts/wr.mjs --cwd .ci-repro/deploy-a deploy --config workers/results-snapshot/wrangler.toml
import { runAll } from "./build.js";

export default {
  async scheduled(event, env) { await runAll(env); },   // a throw shows as a failed cron run in the dashboard
  async fetch() { return new Response("binchika results-snapshot worker", { status: 404 }); },
};
