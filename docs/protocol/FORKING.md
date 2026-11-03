# Fork the Binchika Protocol in 48 hours

This is a working path for a civic-tech group in Ghana, Kenya, Senegal or anywhere else. It assumes one developer, a Cloudflare account and a GitHub account. Facts about your country's election law, dates and parties must come from your electoral body. Do not copy Nigeria's.

## Hour 0–4: accounts and repo
1. Fork `github.com/Bincika/Binchika-v1` (the open-source tree; the original repository stays private). The code is dual-licensed under the MIT License and the Apache License 2.0, so **your fork may use either licence** (or offer both, as we do). Keep the copyright notice and the text of the licence you use (`LICENSE-MIT`, `LICENSE-APACHE`; keeping both files is simplest). If you use Apache 2.0, also keep `NOTICE` (Apache 2.0, section 4(d)). As requested, not required, keep the "Built on the Binchika Protocol" link.
2. Create a free Cloudflare account and add your domain. Create a D1 database and point `wrangler.toml` at it. Enable R2.
3. `cp .env.example .env`, fill it in, and run `git config core.hooksPath scripts/hooks` (the secret guard).

## Hour 4–12: geography and baselines
4. Copy `tenants/_template/tenant.json` to `tenants/<iso>/tenant.json`, fill every `FILL` with a sourced value, and set `"tenant": "<iso>"` in `tenant_config.json`. The build refuses a tenant with gaps (`docs/TENANT-CONFIG.md`).
5. Boundaries: change `NGA` to your ISO3 code in `scripts/fetch-geo.mjs`, then run it and `scripts/build-geo.mjs`. geoBoundaries has ADM1 and ADM2 for every African country, under CC BY 4.0.
6. Write your `states.json` equivalent (areas, seats, capitals) with a source for each field. Run `scripts/validate-data.mjs` and adapt its totals.
7. Baselines: point `scripts/fetch-inec-baselines.mjs` at your electoral body's published registers. Keep the rule that a level is accepted only if its parts sum to the official total.

## Hour 12–24: rules and parties
8. Party register → `parties.json`. Keep the alphabetical colour-slot rule and shuffled order. Party logos come from the electoral body only.
9. Polling-station code format and count → `pollingUnits` in your `tenants/<iso>/tenant.json` (`codePattern`, `statePrefix`, `total`); `stateOfPu()` in `results.js` reads them. Also check the `report.js` regex. See `docs/TENANT-CONFIG.md`.
10. Winning rules → `results.js` (thresholds, spread rules) with the article numbers in comments. Add tests.
11. Translate `src/pages/*`. Keep the "only <electoral body> declares results" notice on every page; `scripts/smoke.mjs` checks for it.

## Hour 24–40: intake and verifiers
12. Pick at least two intake channels (Telegram plus web or SMS). Set `INGEST_TOKEN` and `REPORTER_HASH_SALT`.
13. Supabase project: apply `supabase/migrations/*`, then run `supabase/tests/rls_test.sql` and get 16/16 before inviting anyone.
14. Define verifier regions for your country (6–8, balanced by polling-station load).

## Hour 40–48: prove it
15. `node --test tests/*.test.mjs`, then `scripts/e2e-pipeline.mjs` locally (it must show the 85% rule and a tamper detected).
16. Deploy, run `scripts/smoke.mjs https://your-domain`, and publish your genesis hash.
17. Write a checkpoint in `docs/checkpoints/`.

## What not to fork blindly
- Election dates, party lists, seat counts, thresholds and legal citations. Every one is country-specific.
- Data-protection rules: replace NDPA 2023 with your law (e.g. Kenya Data Protection Act 2019, Ghana Data Protection Act 2012 (Act 843), Senegal Law No. 2008-12). Have a lawyer check them.
