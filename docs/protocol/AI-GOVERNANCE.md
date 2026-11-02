# AI data governance

AI in Binchika **suggests; deterministic code and people decide.** Nothing an AI produces reaches the public ledger without passing the same published rules as everything else, and corrections always need the BinchikAdmin.

## Where AI is used, and for what
| Layer | AI task | Model / where it runs | Output is… |
|---|---|---|---|
| Intake | Image quality check (blur, glare, cropped sheet) | Workers AI vision (Cloudflare) | a hint to the sender to retake the photo |
| Reading | OCR of Form EC8A party totals | Workers AI vision, with on-device Tesseract as a fallback in the app | a **proposed** tally with per-field confidence |
| Re-investigation | Re-reads every photo for a flagged unit, lists disagreements | Workers AI (text + vision) | a summary for the OpsAdmin; **no authority** |
| Manifestos | Summary with page and paragraph citations | LLM, human-reviewed before publishing | a draft; the same template for every party |
| Translation | Hausa, Yoruba, Igbo, Pidgin versions of guidance | LLM, reviewed by native speakers | a draft |

## Where AI is deliberately **not** used
Consensus (≥85% of ≥3), the comparison with IReV, baseline checks, ledger writes, verifier selection, party order and colours, news selection, and anything that says who is "winning". All of these are deterministic, published code.

## Limits we accept and design around
- Handwriting, low light, folds and stamps cause misreads. Every low-confidence field goes to a person.
- A doctored sheet photographed perfectly is still doctored. AI cannot detect fraud on its own; agreement between independent reporters and comparison with IReV and the baselines are what catch it.
- Language models can invent text ("hallucinate"). Summaries must quote and cite, and any unsupported sentence is removed by the reviewer.
- Models can carry bias across scripts and handwriting styles. We monitor error rates by state and, if one region misreads more, route that region to people.

## The AI constitution (every AI component must comply)
1. **Suggest, never decide.** AI output is a proposal; published rules and humans decide.
2. **Label everything.** Every AI output is marked as AI-generated and logged with the model, version, input hash and time.
3. **No personal data.** AI never receives names, phone numbers or faces. Handles are hashed, EXIF is stripped and faces are blurred before any model sees an image. Real user data is never sent to external third-party models.
4. **Rules beat models.** If the AI disagrees with the deterministic rules, the rules win, and the case goes to a person.
5. **Say how sure it is.** Every reading carries a confidence score. Below the threshold (0.9 per field), a human must confirm.
6. **No politics.** AI never predicts winners, writes persuasion, or treats any party differently. The same prompts and pipeline apply to all parties.
7. **Auditable.** Same input, logged output. Anyone can ask to re-run an AI step on the public evidence.
8. **Least power.** AI has no write access to the ledger, the verifier database or results tables. It writes only to a review queue.
9. **Kill switch.** Any AI step can be switched off, and the system then runs human-only, slower but intact.
10. **Corrections are human.** Only the BinchikAdmin approves an overwrite after AI re-investigation, and that approval is a new public ledger entry.

## Do's and don'ts for anyone building on the protocol
**Do:** keep AI behind a review queue; publish confidence; log model versions; test on real, varied handwriting from every region; prefer models that run on Cloudflare or on-device.
**Don't:** let AI write to the ledger; send identifiable data to external APIs; generate political content; use AI to rank, score or select verifiers; describe anything as "AI-verified".

## Implemented (session 88)
- A result-sheet reading counts toward consensus only after a verifier confirms it beside the photo (`POST /api/portal/review`), or if a calibrated machine reading cleared every field (`ocr_done`). `needs_review` no longer counts (`functions/_lib/pipeline.js`).
- The contained OCR (`docs/protocol/OCR.md`) is switched off by default, reads only photos cleared by the people check, stores per-field confidence, and only ever proposes.
- Every unit must pass the posting gates (`functions/_lib/ec8a.js`) before the ledger: polling-unit position, high consensus, confirmed readings, balanced control totals, and the baseline check.

## Human checkpoints
| Step | AI responsible? | Human checkpoint |
|---|---|---|
| Photo quality hint | Yes | None (advisory only) |
| OCR tally | Proposes | Required below 0.9 confidence; random 5% sample above it |
| Consensus and ledger entry | No (deterministic) | Not needed: rules are public code |
| Discrepancy flag | No | Raised by an SZV, reviewed by an NRV |
| Re-investigation | Summarises | OpsAdmin reviews |
| Correction (overwrite) | No | **BinchikAdmin approval, always** |
| Manifesto summary / translation | Drafts | Reviewer approves before publishing |
