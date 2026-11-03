# "Africa's First Decentralised Election Ledger": what is true and what still needs proof

## Already true (verified by tests or live checks)
- **Public, append-only, hash-chained ledger.** It is live at binchika.com/ledger. UPDATE and DELETE are refused by the database. Any visitor can re-verify the whole chain in their browser. Tampering is detected (e2e test).
- **The arithmetic is public code.** The ≥85% / ≥3-reporter consensus rule, the official-vs-citizen comparison, the constitutional spread rules (s.134, s.179) and the baseline discrepancy rule are all open-source and unit-tested (31 tests).
- **Forkable.** Dual licence (MIT or Apache-2.0, your choice), tenant config, and a 48-hour fork guide.
- **Neutral by construction.** Alphabetical colour slots, shuffled party order, equal cards, no ads, and an INEC-only-declares notice on every page (smoke-tested).
- **Pre-election baselines are captured and hashed.** INEC registered voters for 37/37 states (sum = 93,469,008) and 56 LGAs, with document SHA-256 and fetch time.

## Not yet true: needed before the claim is fully earned
- **Decentralised storage.** Evidence is not on IPFS yet. R2 must be enabled, then CIDs computed and bundles pinned. Today the ledger lives on Cloudflare D1 plus a GitHub mirror, which is distributed but not decentralised.
- **Independent pinners.** The ledger becomes takedown-resistant only once at least two organisations outside Binchika pin the bundles.
- **Real election traffic.** Nothing has run on an election day yet, so 176,846-unit scale, OCR accuracy and multi-channel intake are untested.
- **Verifier anonymity is pseudonymous, not zero-knowledge** (see ANONYMOUS-VERIFIERS.md).
- **"First".** We have not done a formal survey of every African civic-tech election project. The claim should be framed as "the first *open, hash-chained, forkable* election ledger we know of in Africa" until someone checks it independently.

## Wording rule
Say "**Africa's First Decentralised Election Ledger**: a citizen transparency layer". Never say "election system", "official results" or "winner".
