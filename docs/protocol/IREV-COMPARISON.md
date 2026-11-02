# IReV comparison: the exact flow (session 88)

For verifiers and anyone checking Binchika's work. **Only INEC declares results.**

## Where the official figure comes from
INEC publishes each polling unit's Form EC8A on IReV (the INEC Result Viewing portal) as a document, not as an API. So an official figure enters Binchika one unit at a time:

`POST /api/pipeline/official {puCode, race, tally, documentUrl, source}` (Bearer `INGEST_TOKEN` only). An operator or a reader transcribes the IReV sheet, including its https link (`documentUrl`). It is checked like any reading: a real polling-unit position, whole numbers, and no "VOID" or "REJECTED" party. It is stored in D1 `official_results` (one row per unit, race and source; a newer copy replaces the older). Nothing scrapes INEC.

## What happens next, step by step (`functions/_lib/pipeline.js` `processUnit`)
1. **Readings that count:** result-sheet readings a verifier has confirmed (`verified`), or a calibrated machine reading that cleared every field (`ocr_done`). `needs_review` does not count. Approved alternative evidence can make a unit "lower" at most.
2. **Consensus** (`consensus.js`): at least 3 independent readings agreeing at 85% or more make the unit `high`.
3. **IReV comparison** (`compareWithOfficial`): the agreed citizen tally is compared party by party with the latest official figure for the unit. Every difference is listed with both numbers and the difference: for example PDP citizen 37, official 40, delta −3.
4. **Baseline** (`baseline.js` `checkAgainstBaseline`): on each counted sheet, accredited voters and votes cast must not exceed the register printed on it.
5. **Posting gates** (`ec8a.js` `postingGates`): polling-unit position, high consensus, confirmed readings, every counted sheet balances, and no baseline breach. **All must pass.** A high unit that fails a gate is stored as `held`: not posted and not in the public totals.
6. **Ledger:** a unit that passes every gate is appended (new entry only when the posted tally is new or changed). The entry carries the official figure, its source and document link, the difference (if any) and the gate result.

## What a difference means
- It is **shown, not hidden**. The citizen tally is still published (constitution §4), beside the official figure with both sources. It is on the ledger entry and in `unit_consensus.discrepancy_json`. `/api/results` and `/api/press/snapshot` show how many published units were compared and how many differ. In the portal, the unit line says "differs from IReV".
- It is **not** an accusation. A difference can be a misread photo, a late IReV upload or a changed sheet. Binchika never says a party "won" or "stole" a unit.
- **What a verifier does:** open the unit's readings, check the photos against both figures, and raise a flag (SZV) if a reading looks wrong. Corrections then follow the three-seat rule (`docs/QUORUM-CORRECTIONS-DESIGN.md`).

## Tests
`tests/readiness-fixes.test.mjs` ("IReV: a difference is stored, surfaced and does not block…") and `tests/evidence.test.mjs`.
