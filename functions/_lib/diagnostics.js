// Owner-only diagnostics (session 143; docs/egm/owner-diagnostics/build-plan.md). Read-only: is the site wired, and is
// the Android app link in place? Secrets are reported as set or missing only: never a value, length, prefix or hash.
// No table is read, nothing is counted, nothing is stored or logged. Every probe has a time limit and a failure is false.
import { supaConfigured } from "./supa.js";

const BINDINGS = ["DB", "EVIDENCE", "AI"];
const SECRETS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "INVITE_PEPPER", "RESEND_API_KEY", "UNSUBSCRIBE_KEY", "INGEST_TOKEN", "REPORTER_HASH_SALT", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_S3_ENDPOINT"];
const NOTICE_VERSION = /^[A-Z]{2,4}-\d{4}-\d{1,3}$/;
const PACKAGE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const NO_LINK = { readable: false, package: null, fingerprints: 0, playSigningKeyListed: false };

/** Resolves to `fallback` if the work throws or takes longer than `ms`. */
function within(ms, fallback, work) {
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  const run = (async () => { try { return await work(); } catch { return fallback; } })();
  return Promise.race([run, limit]).finally(() => clearTimeout(timer));
}

async function appLink(readAssetLinks) {
  if (typeof readAssetLinks !== "function") return NO_LINK;
  const r = await readAssetLinks();
  if (!r?.ok) return NO_LINK;
  const first = JSON.parse(await r.text())?.[0];
  const prints = first?.target?.sha256_cert_fingerprints;
  if (first?.target?.namespace !== "android_app" || !Array.isArray(prints)) return NO_LINK;
  const n = prints.filter((p) => typeof p === "string" && FINGERPRINT.test(p)).length;
  const pkg = first.target.package_name;
  return { readable: true, package: typeof pkg === "string" && PACKAGE.test(pkg) ? pkg : null, fingerprints: n, playSigningKeyListed: n >= 2 };
}

/**
 * @param {object} env  the Pages environment
 * @param {{ fetchImpl?: typeof fetch, readAssetLinks?: () => Promise<Response>, now?: () => Date, timeoutMs?: number }} deps
 */
export async function collect(env, { fetchImpl = fetch, readAssetLinks, now = () => new Date(), timeoutMs = 4000 } = {}) {
  const configured = supaConfigured(env);
  const notice = env.PRIVACY_NOTICE_VERSION;
  const [dbReachable, supaReachable, link] = await Promise.all([
    within(timeoutMs, false, async () => Boolean(env.DB) && (await env.DB.prepare("SELECT 1 AS ok").first())?.ok === 1),
    within(timeoutMs, false, async () => configured && (await fetchImpl(`${env.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY } })).ok === true),
    within(timeoutMs, NO_LINK, () => appLink(readAssetLinks)),
  ]);
  return {
    time: now().toISOString(),
    bindings: Object.fromEntries(BINDINGS.map((n) => [n, Boolean(env[n])])),
    secrets: Object.fromEntries(SECRETS.map((n) => [n, Boolean(env[n])])),
    switches: {
      // The same four-part rule as /api/apply.
      applicationsOpen: env.APPLICATIONS_OPEN === "true" && Boolean(notice) && configured && Boolean(env.INVITE_PEPPER),
      privacyNoticeVersion: !notice ? null : NOTICE_VERSION.test(String(notice)) ? String(notice) : "set",
      ocrEngine: env.OCR_ENGINE === undefined || env.OCR_ENGINE === "off" ? "off" : env.OCR_ENGINE === "workers-ai" ? "workers-ai" : "other",
      resultsSource: env.RESULTS_SOURCE === "snapshot" ? "snapshot" : "scan",
    },
    database: { reachable: dbReachable },
    supabase: { configured, reachable: supaReachable },
    appLink: link,
  };
}
