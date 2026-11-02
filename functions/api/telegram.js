// POST /api/telegram — Telegram bot webhook.
// Register: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://binchika.com/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
import { parseTelegramUpdate, hashReporter } from "../_lib/report.js";

const ok = () => new Response("ok");

async function reply(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN || chatId == null) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.REPORTER_HASH_SALT) return new Response("not configured", { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

  let update;
  try { update = await request.json(); } catch { return ok(); } // always 200 so Telegram doesn't retry junk
  const r = parseTelegramUpdate(update);
  if (!r || !r.handle) return ok();

  if (!r.mediaRef) {
    await reply(env, r.chatId, "Sannu! Send a clear photo of the result sheet (Form EC8A) posted at your polling unit. Put the polling-unit code in the caption, e.g. 24-09-05-012. Photograph the sheet only, not people. Binchika is not INEC; only INEC declares results.");
    return ok();
  }
  const reporterHash = await hashReporter(env.REPORTER_HASH_SALT, "telegram", r.handle);
  await env.DB.prepare(
    "INSERT INTO reports (id, channel, reporter_hash, pu_code, media_ref, caption, status) VALUES (?1, 'telegram', ?2, ?3, ?4, ?5, 'ocr_pending')"
  ).bind(crypto.randomUUID(), reporterHash, r.puCode, r.mediaRef, r.caption?.slice(0, 2000) ?? null).run();
  await reply(env, r.chatId, r.puCode ? `Received for polling unit ${r.puCode}. Thank you, mu bincika tare.` : "Received, thank you. Please also send the polling-unit code (e.g. 24-09-05-012) so we can match it.");
  return ok();
}
