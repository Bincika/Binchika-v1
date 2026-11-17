# Binchika: an open, forkable citizen tally ledger

**Mu bincika tare: let us examine it together.**

Binchika is a citizen transparency layer for elections. Citizens report the result sheet posted at their polling station. Independent reports are compared, and a unit is published only when at least three separate reports agree on at least 85% of the figures and a trained volunteer confirms them. Every published unit goes into a public, tamper-evident hash chain that anyone can verify in the browser.

**Binchika never declares results.** Only the electoral body does. Every page, feed and API response says so.

This repository ships with **Exampleland, a fictional country**, so that a fresh copy builds and runs. Every area, party, date and figure in it is invented. It is dual-licensed under **MIT or Apache 2.0** so any civic-tech group can fork it and run it for its own election. It began as the build behind a real deployment, which is a separate, private repository and is not built from here.

## Reconfigure it for your country
- `tenant_config.json` names the active tenant (`"tenant": "example"`);
- `tenants/<id>/tenant.json` holds the country, electoral body, notice, time zone, polling-station code format and count, rules and wording;
- the schema is `tenants/tenant.schema.json`;
- a blank to fill in is `tenants/_template/tenant.json`, which the build refuses until it is complete.

The build generates the module the server and browser code read. You also replace the data in `site/data/` and the text in `src/pages/`.

- **How the config works and what is still country-specific:** [`docs/TENANT-CONFIG.md`](docs/TENANT-CONFIG.md)
- **A 48-hour path from fork to a running site:** [`docs/protocol/FORKING.md`](docs/protocol/FORKING.md)

## Run it
```bash
npm ci --omit=dev --ignore-scripts
node scripts/validate-data.mjs
node --test tests/*.test.mjs
node scripts/build-site.mjs
```
These are the same steps as CI (`.github/workflows/ci.yml`). Deployment uses Cloudflare Pages + D1 + R2 and Supabase (sign-in and verifier records). Copy `.env.example` to `.env` for your own keys, and see `docs/TENANT-CONFIG.md` §5 for the identifiers to replace.

## What is in here
| Folder | Contents |
|---|---|
| `functions/` | Cloudflare Pages Functions: intake, consensus, ledger, results, press feed, admin dashboard APIs |
| `workers/` | Email Worker (mailbox) and the daily retention Worker |
| `src/`, `site/` | Page sources and the built static site (the example tenant's text and data) |
| `db/d1/`, `supabase/` | D1 and Supabase migrations, with row-level-security tests |
| `tenants/`, `tenant_config.json` | Country configuration |
| `tests/` | Unit tests (`node --test`) |
| `docs/protocol/` | Protocol notes: forking, ingestion, anonymous verifiers, evidence storage and costs, OCR, AI governance |

## Principles a fork should keep
- Only the electoral body declares results. Binchika shows citizen-verified tallies, never winners or projections.
- Neutrality: no party gets a louder voice, colour or position.
- Privacy by default: reporters are stored only as salted hashes, verifiers are pseudonymous, and no personal data is collected before a published privacy notice is in force.
- Secrets never go in git. Install the guard: `git config core.hooksPath scripts/hooks`.

## Licence
This project is dual-licensed under the MIT License and the Apache License 2.0. You may choose either licence.
- MIT: [`LICENSE-MIT`](LICENSE-MIT)
- Apache 2.0: [`LICENSE-APACHE`](LICENSE-APACHE)

SPDX expression: `MIT OR Apache-2.0`. Forks may use either licence. Attribution notes and third-party data licences are in [`NOTICE`](NOTICE). A "Built on the Binchika Protocol" link is appreciated, not required.
