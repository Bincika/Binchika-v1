// binchika-keepalive: every 3 days, call public.keepalive_ping() (create → write → drop a dummy table)
// so the free Supabase project never reaches 7 days of inactivity. Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Since session 63 the same run also applies the privacy notice's retention periods (retention.js, docs/RETENTION.md).
import { runRetention } from "./retention.js";
async function ping(env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/keepalive_ping`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" },
    body: "{}",
  });
  const body = await r.text();
  console.log(JSON.stringify({ event: "keepalive", status: r.status, at: body.slice(0, 40) }));
  if (!r.ok) throw new Error(`keepalive failed: ${r.status}`); // shows as a failed cron run in the dashboard
  return body;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(Promise.all([ping(env), runRetention(env)])); },
  async fetch() { return new Response("binchika keep-alive worker", { status: 404 }); },
};
