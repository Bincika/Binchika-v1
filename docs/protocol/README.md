# The Binchika Protocol

**Africa's First Decentralised Election Ledger** is a citizen transparency layer that does the arithmetic in public. It is not an election system. It never declares results; only the national electoral body does (INEC in Nigeria).

The protocol is MIT-licensed (see `/LICENSE`). Nigeria is the first fully configured tenant (`tenants/ng/tenant.json`).

## What the protocol is
| Layer | What it does | Where |
|---|---|---|
| Intake | Citizen photos of the posted polling-station result form arrive from many channels. Reporter handles are salted-hashed on arrival. | `functions/api/reports.js`, `functions/api/telegram.js`, `functions/_lib/report.js` |
| Consensus | A tally is **high confidence** when ≥85% of ≥3 independent reporters agree. Ties and splits are never resolved silently. | `functions/_lib/consensus.js` (tested) |
| Comparison | The consensus tally is compared with the official upload, and every differing party is listed with its delta. | `compareWithOfficial()` |
| Baselines | Pre-election registered voters per area, timestamped and hashed. Election-day figures above or materially off the baseline are flagged. | `functions/_lib/baseline.js`, `scripts/fetch-inec-baselines.mjs` |
| Ledger | Append-only and SHA-256 hash-chained. The database refuses UPDATE and DELETE. Corrections are new entries. Anyone can verify the chain in a browser. | `functions/_lib/ledger.js`, `db/d1/0002_ledger.sql`, `/ledger/` |
| Evidence | Images in R2; content IDs (IPFS CIDs) recorded in the ledger; selective IPFS pinning | `docs/protocol/EVIDENCE-STORAGE-AND-COSTS.md` |
| Verifiers | Pseudonymous public IDs. Verifiers flag; AI re-investigates; the BinchikAdmin decides. Database-enforced state binding. | `supabase/migrations/`, `docs/protocol/ANONYMOUS-VERIFIERS.md` |

## Forking
See `FORKING.md`: a 48-hour path to a local instance for Ghana, Kenya, Senegal or any other country.

## Honest status
See `STATUS.md` for what is already true and what still needs proof before the "Africa's First…" claim is fully earned.
