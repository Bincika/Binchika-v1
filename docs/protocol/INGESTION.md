# Multi-channel intake design (Telegram is not enough)

Goal: no single platform, API change or shutdown can silence intake. Everything converges on one validated path.

```
 Telegram ┐  WhatsApp Cloud API ┐  X / Threads / Instagram (mentions) ┐  Discord bot ┐  Signal (signal-cli bridge) ┐
 Web upload (binchika.com, offline-first PWA queue) ┐  SMS (Africa's Talking short code; text tallies, no photo) ┐
                                    ▼  each adapter: verify webhook signature → salt-hash handle → normalise
                     POST /api/reports  (Bearer INGEST_TOKEN for adapters; Turnstile for web)
                                    ▼
                  Cloudflare Queue "intake"  (absorbs election-night spikes; retries with backoff; DLQ)
                                    ▼  consumer Worker
       photo → R2 (sha256 key, EXIF stripped) → CIDv1 computed → OCR (Workers AI vision) → tally_json
                                    ▼
                  /api/pipeline/unit → consensus (≥85% of ≥3) → IReV compare → baseline check → ledger
                                    ▼  high-confidence only
                  hourly state bundle (CAR) → Pinata / Storacha pin → bundle CID into the ledger + GitHub mirror
```

## Rules every adapter follows
- Verify the platform's webhook signature or secret before anything else (Telegram secret token, Meta X-Hub-Signature-256, Discord Ed25519).
- Turn the handle into `sha256(salt:channel:handle)` immediately and never store the raw handle.
- Never block on downstream work: acknowledge fast (platforms retry on slowness), enqueue, and process asynchronously.
- Be idempotent: the dedupe key is `channel + platform message id`, so retries never double-count.
- **Soft per-state allocation:** queue consumers take turns across states, so one flooded state cannot starve the others.
- **Graceful degradation:** if OCR is down, reports wait in `ocr_pending`. If R2 is down, the adapter stores the platform file reference and fetches it later. If the internet is cut, SMS still carries text tallies, and the PWA queues photos offline and uploads when back online.

## Status (25 Oct 2026)
- Live: `/api/reports` (token), `/api/telegram` (needs a bot token), the consensus pipeline and the append-only ledger.
- Next: **enable R2**, then the Queue + consumer Worker, the WhatsApp Cloud API adapter, the web upload with Turnstile, and SMS.
