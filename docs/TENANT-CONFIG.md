# Tenant configuration: running Binchika for another country

_Session 98, 2 November 2026. Applies to github.com/Bincika/Binchika-v1 (open source, MIT) and to the Nigeria deployment at binchika.com, which runs on the same code with the Nigeria tenant._

## The idea in one paragraph
Everything that names a country lives in one tenant folder. `tenant_config.json` (repository root) says which one is active:

```json
{ "tenant": "ng" }
```

The build (`node scripts/build-site.mjs`) reads `tenants/<id>/tenant.json`, checks it, and writes two files:
- `functions/_lib/tenant.generated.js`, used by the Pages Functions and the mailbox Worker, and copied to `site/assets/js/lib/` for the browser;
- `site/data/locale.json`, for the header clock.

Code reads `TENANT.…`, never a country literal. A fork copies `tenants/_template/`, fills it in, points `tenant_config.json` at it and rebuilds.

## Schema (`tenants/tenant.schema.json`)
| Field | Used for | Nigeria value |
|---|---|---|
| `id`, `country`, `iso` | folder name, labels, area-code prefix | `ng`, Nigeria, NG |
| `domain`, `site.origin` | canonical URLs, sitemap | binchika.com |
| `site.sourceRepo` | "Open source (MIT)" footer link | github.com/Bincika/Binchika-v1 |
| `locale.lang`, `timeZone`, `zoneLabel`, `utcOffset`, `city` | every displayed date and time, header clock | en-GB, Africa/Lagos, WAT, UTC+1, Abuja |
| `electoralBody.name`, `short`, `url`, `resultsPortal`, `resultsPortalShort` | "Only <short> declares results", official-result comparisons | Independent National Electoral Commission, INEC, IReV |
| `notice` | the line shown beside every figure (press feed, API, media terms) | Citizen-verified tallies. Only INEC declares results. |
| `pollingUnits.total`, `totalSource` | coverage denominator ("N of total") | 176,846; INEC 2023 polling units |
| `pollingUnits.codePattern` | the official polling-station code | `^\d{2}-\d{2}-\d{2}-\d{3}$` |
| `pollingUnits.statePrefix` | code prefix → ISO 3166-2 area | `"24"` → `NG-LA`, … 37 entries |
| `geography.*`, `parties`, `races`, `elections`, `baselines` | where the country's data files are | `site/data/…` |
| `resultForm`, `rules.winning` | documentation of the result sheet and legal rules | Form EC8A; Constitution s.134(2), s.179(2) |
| `rules.consensus` | the 85% / 3-report rule | 0.85, 3 |

`scripts/lib/tenant.mjs` refuses a tenant with a missing field or a leftover `FILL`, and names the problem. `tests/tenant.test.mjs` checks four things:
- the committed generated module matches the tenant (rebuild after any edit);
- the Nigeria values are exactly the pre-config ones;
- the template is refused until it is filled in;
- no code hard-codes a time zone.

## What is config-driven today
- **Server:** the polling-unit table (`functions/_lib/results.js`; every importer of `INEC_STATE_CODE` / `REGION_CODE`), the API and ledger notices, the press-feed notice, the polling-unit total and source, media terms and replies, and the time zone of every email and record.
- **Browser:** the polling-unit tables in the portal and ledger, every displayed time zone and zone label (ledger, map, tally dashboard, monitor, join, pledge, portal), the tally-dashboard disclaimer and the header clock.
- **Build:** the footer's source link, the site origin and `locale.json`.

## What is still country-specific (measure it with `node scripts/tenant-audit.mjs --files`)
Session 98 count for Nigeria: config 44 · data 1,076 · content 891 · **code 587** · tests 78.

| Area | Where | What a fork does |
|---|---|---|
| Country data | `site/data/` (states, LGAs, geo TopoJSON, parties, races, baselines, elections, register), `data/raw/` | Replace with your own, each value with a source. `scripts/fetch-geo.mjs` (geoBoundaries) and `scripts/validate-data.mjs` help. |
| Page text | `src/pages/*.html`, `src/kb/*.md` | Rewrite: history, law, demographics and help answers are about Nigeria. Keep the "only <body> declares results" notice on every page; `scripts/smoke.mjs` checks for it. |
| Verifier seats | `supabase/migrations/0002_seed.sql`, `0004_seats.sql`, `0010_szv_recalibration.sql` and their tests | Generate your seat list (`scripts/gen-seats-sql.mjs` shows the pattern) for your regions. |
| Legal and race rules | `functions/_lib/results.js` (winning rules, off-cycle governorships), `site/data/races.json` | Write your country's rules with article numbers, and tests for them. |
| Result-sheet checks | `functions/_lib/ec8a.js` (Form EC8A arithmetic and code checks), `functions/_lib/ocr.js` | Adapt to your sheet's fields. The arithmetic idea (totals must add up) carries over. |
| Official-result comparison | `functions/api/pipeline/official.js` (IReV) | Point at your electoral body's portal, or leave it off. |
| Scripts | `scripts/smoke.mjs`, `scripts/fetch-inec-baselines.mjs`, `scripts/build-register-report.mjs`, `scripts/e2e-pipeline.mjs` | Change the URLs and expected values for your deployment. The live deployment's operational scripts (Supabase keys and auth settings, Cloudflare routing, secrets, sign-in and e2e probes of binchika.com) are not in the open-source tree; write your own for your accounts. |
| Comments | throughout | Harmless; they explain the Nigeria example. |

## Standing up a new country (short version; the full path is `docs/protocol/FORKING.md`)
1. Fork github.com/Bincika/Binchika-v1. Keep the MIT licence and `NOTICE`.
2. `cp -r tenants/_template tenants/<iso>`, fill every `FILL` with a sourced value, and set `"tenant": "<iso>"` in `tenant_config.json`.
3. Replace the country data in `site/data/` (keep the file shapes) and rewrite `src/pages/`.
4. `node scripts/build-site.mjs`, then `node --test tests/*.test.mjs`. Nigeria fixtures in some tests will fail until you change them for your country; they tell you what to change.
5. Your own accounts and identifiers:
   - a Cloudflare D1 database (`wrangler d1 create`; put its id where the `wrangler.toml` files say `REPLACE`);
   - an R2 bucket;
   - a Supabase project (in `.env`, and its address in `site/_headers` where it says `YOUR-PROJECT`);
   - the SHA-256 of your administrator's address in `functions/_lib/supa.js` and the admin-lock migration. The export uses `admin@example.org`; never commit the address itself.
6. `git config core.hooksPath scripts/hooks` (secret guard). Secrets go in `.env` and Cloudflare/Supabase secret stores, never in git.

## Publishing the open-source tree (maintainers of the Nigeria deployment)
`node scripts/export-open-source.mjs` builds `.oss-export/tree` from committed files only:
1. it keeps an allowlist and drops internal history (checkpoints, handoff, owner actions, reports, the internal constitution), owner papers, campaign media and the live deployment's operational scripts;
2. it replaces deployment identifiers with placeholders (D1 id, Supabase project ref, Pages subdomain, the admin address hash);
3. it writes `README.md` from `docs/OPEN-SOURCE-README.md`;
4. it **fails** if a token, key, local path, deployment id, the Supabase project ref, a binchika Pages subdomain, the admin hash or the owner address is left.

Some code comments still name internal documents that are not exported (for example `docs/HANDOFF.md`, `docs/RETENTION.md`, `docs/egm/…`). They are harmless pointers for the original team.

It never pushes. Run the CI steps inside the tree, then push it as a normal commit to github.com/Bincika/Binchika-v1 (never force).
