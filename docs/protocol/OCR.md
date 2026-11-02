# Contained OCR for Form EC8A (session 88)

**Status:** built, tested, deployed **switched off** (`OCR_ENGINE = "off"` in `wrangler.toml`). Turning it on is an owner decision (see the end).

## What it does
`POST /api/pipeline/ocr {reportId}` (Bearer `INGEST_TOKEN`; bots and processing workers only, never the public) reads one report's processed photo with Workers AI vision (`@cf/meta/llama-3.2-11b-vision-instruct` by default; `OCR_MODEL` overrides it) and records the result in D1 `report_checks`. Code: `functions/_lib/ocr.js`, `functions/api/pipeline/ocr.js`.

## How it obeys the AI constitution (`docs/protocol/AI-GOVERNANCE.md`)
| Rule | How |
|---|---|
| Suggest, never decide | A reading is a **proposal**. It fills the report's tally only if the report has none, and always as `needs_review`. Only a verifier's confirmation (`POST /api/portal/review`) makes it count. |
| No faces | It reads only photos the people check has cleared (`face_check = "none"`). `unchecked` and `detected` are **withheld**. With no people detector configured today, every photo is `unchecked`, so the OCR would withhold them all: that is the fail-closed default. |
| Say how sure it is | Per-field confidence (polling unit, parties, register, accredited, rejected). Any field below 0.9 is listed for the verifier as "check carefully". |
| Fail closed | No binding, the engine off, an engine error, a video, unreadable output, a non-whole number or a missing party figure: **withheld**, with a reason, and nothing is filled in. |
| Rules beat models | The proposed figures go through the same control-total check (`functions/_lib/ec8a.js`) as any typed reading. An unbalanced sheet cannot be confirmed. |
| Auditable | Model, input SHA-256, time and transcript are stored with the result (`ocr_json`). |
| Least power | The OCR writes only to `report_checks` and to an empty `tally_json` with status `needs_review`. It never writes `unit_consensus`, the ledger or results. |
| Kill switch | `OCR_ENGINE = "off"`; the system then runs human-only. |

## The verifier's side
Portal → Incoming reports → **Check reading**: the photo on the left, and on the right the reading, the control totals, the machine transcript and its lowest confidence (if any), and why the sheet does or does not balance. **Confirm reading** or **Reject reading**, with a reason. A verifier cannot change the numbers. Corrected control totals can be entered from the photo, and they must balance.

## The Windows reader
`sandbox/readiness/ocr-windows.ps1` stays a local instrument for testing only. It is not called by the site.

## Before switching it on (owner)
1. A people detector, so photos can be cleared (until then the OCR withholds everything).
2. Privacy-notice wording for AI reading of result-sheet photos by Cloudflare Workers AI.
3. Set `OCR_ENGINE = "workers-ai"`, deploy to a preview, and run it on test sheets first.
