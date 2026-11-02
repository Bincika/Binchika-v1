# Anonymous verifiers: identity minimisation

## What is implemented now (Supabase migrations 0001 and 0003, RLS-tested)
- **Public ID:** each verifier gets a sequential **5-character alphanumeric public ID** (`V0001`, `V0002`, … then base-36 once the numbers run out). It is the only identifier other verifiers and the public ever see.
- **Real identity is admin-only.** Email and application answers sit in `verifier_applications`, which has no client access at all. The `auth.users` link is readable only by admins (OpsAdmin and BinchikAdmin), through RLS.
- **Hashed IDs.** PVC VIN and NIN are stored as salted SHA-256 hashes plus the last 4 characters, which is enough to detect a duplicate person and useless to anyone who steals the table.
- **Flags carry the public ID, not the account.** The `verifier_flags_public` view exposes `raised_by_public_id` and hides `created_by`.
- **Chain of responsibility:** SZV → regional NRV → OpsAdmin → BinchikAdmin. Only the BinchikAdmin can approve a correction, and the correction goes into the ledger as a new entry that references the flag and the public IDs. It never references a person.
- **Verifiers never write results.**

## What is not yet zero-knowledge, stated plainly
Today the database operator (BinchikAdmin) can link a public ID to a person. That is required for accountability and for the 24 h / 6 h offer process. True zero-knowledge membership (proving "a valid verifier of Lagos raised this flag" without revealing which one) would need group-membership proofs, for example Semaphore-style ZK proofs with a Merkle tree of verifier commitments. It is on the roadmap. It is not claimed today.

## Cryptographic binding (next step)
- Each verifier generates a keypair in the browser (WebCrypto, non-extractable). The public key is registered against their public ID, and flags are signed client-side.
- The ledger stores the public ID plus a signature, so outsiders can check that a flag came from a registered verifier ID without learning who that is.
