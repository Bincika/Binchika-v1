# Verifier invite-code flow

_Status: **built (session 6, 26 Oct 2026)**: migration `0007_invites_pledges.sql`, `functions/_lib/invites.js`, `/api/join/*`, `/api/admin/invites`, `/api/admin/release`, `/join/`, `/join/pledge/` and portal Seats/Account. It is inert until applications open, because every invite needs a screened application (constitution §5: no applications before the privacy notice). It extends the existing `verifier_offers` table (24 h first wave, 6 h backfill), the seat binding (`0004_seats.sql`) and the hierarchy guards (`0003`). Display names: **BinchikAdmin** (role key `superadmin`) and **OpsAdmin** (role key `admin`)._

## 1. The flow at a glance

```
BinchikAdmin                 Invitee (SZV / NRV)                     Server (Pages Function + Supabase)
─────────────                 ───────────────────                     ──────────────────────────────────
1. Pick an open seat  ───────────────────────────────────────────▶   generate code, store SHA-256 only,
   (+ the screened                                                    expires 24 h (or 6 h on backfill)
   applicant)                                                         email code from noreply@ (verificationCode)
                              2. Open binchika.com/join/
                                 enter code ─────────────────────▶   check: exists, pending, not expired,
                                                                      attempts < 5 → show seat + area only
                              3. Enter email, password,
                                 state / region ─────────────────▶   area must equal the seat's area (and the
                                                                      application's state); claim code once;
                                                                      create Auth user (unconfirmed);
                                                                      verifiers row: seat bound, active = false
                              4. Branded confirmation email ◀──────   Supabase admin "generate link" (signup)
                                 from noreply@binchika.com            sent through Resend with our template
                              5. Click link → /join/pledge/
                                 type full name, tick, sign ─────▶   store pledge (version, text hash, typed
                                                                      name, server timestamp); active = true;
                                                                      welcome packet email; seat shows "Taken"
6. Later: Release seat (reason)  ───────────────────────────────▶   deactivate, unbind seat, end sessions,
   → Re-invite next applicant                                         seat event logged; seat shows "Open"
```

## 2. Step by step

### Step 1: generate a code (BinchikAdmin only)
- In the portal's Seats section, the BinchikAdmin chooses an **open** seat and, normally, the highest-ranked eligible applicant for that state (or region, for NRV seats). `POST /api/admin/invites { seat, applicationId? }`.
- **Code:** 8 characters from Crockford base32 (no 0/O/1/I/L), shown as `K7QM-4XPD`. That is about 40 bits; with single use, expiry and 5 attempts per code it cannot practically be guessed.
- Only `sha256(code + INVITE_PEPPER)` is stored (`verifier_offers.code_hash`). The code itself is emailed once with the existing `verificationCode` template and shown once to the BinchikAdmin. It is never logged.
- Window: **24 h** for first-wave offers, **6 h** for backfill (constitution §4a). `expire_and_backfill()` already handles both.

### Step 2: enter the code
- `/join/` asks for the code only. `POST /api/join/check { code }` returns the seat number and area (for example "SZV-073 · Lagos"), nothing else.
- Five wrong attempts per code, or 10 per IP address per 15 minutes, then a cool-down. Error messages are generic ("That code isn't valid or has expired"). Cloudflare Turnstile on the form keeps bots out.

### Step 3: email, password, state or region
- Fields: email, password (minimum 12 characters, checked against common-password lists), confirm password, and **state** (SZV) or **region** (NRV).
- The state or region must match the seat's area. For an SZV it must also match the state on the accepted application. This is the same rule the database already enforces (`enforce_seat`, `enforce_verifier_state`). A mismatch is refused, not corrected.
- `POST /api/join/claim` claims the code atomically (`update … set status = 'accepted' where id = … and status = 'sent' and expires_at > now() returning *`), so one code yields at most one account.
- The server creates the Supabase Auth user through the admin API (public sign-ups stay **off**), then inserts the `verifiers` row with `seat_code` bound and `active = false`. The public ID (V0002, V0003…) is issued now.

### Step 4: branded confirmation email
- The server asks Supabase for a confirmation link (admin "generate link", type `signup`) and sends it through Resend from **noreply@binchika.com** with a new `seatConfirmation({ seat, publicId, link })` template in `functions/_lib/emails.js`: the dash icon, "Confirm seat SZV-073", one button, and expiry in 24 hours.
- Supabase's own mailer is not used for this step, so branding and sender stay consistent.

### Step 5: typed-name pledge
- The confirmation link lands on `/join/pledge/`. The page shows the pledge (section 4), its version and its SHA-256.
- The invitee types their **full name** and ticks "I have read and accept the Binchika verifier pledge".
- The server stores `verifier_pledges (user_id, seat_code, public_id, pledge_version, pledge_sha256, typed_name, signed_at default now())`. The timestamp is the server's, shown in WAT.
- The typed name is stored privately, with no client access, readable only by the BinchikAdmin. It is never shown to other verifiers or the public.
- Then `active = true`, the welcome packet goes out, and the seat board shows the seat as taken.
- The public record gets a **seat event** that carries no name: "SZV-073 · V0002 · pledge P-2026-2 signed 2026-12-07 14:05 WAT".

### Step 6: remove and reassign (BinchikAdmin only)
- **Release seat** needs a written reason. It sets `active = false` and `seat_code = null`, ends the person's sessions (Auth admin sign-out, and a ban so the account can't sign back in), and appends a `seat_events` row. That table is append-only, blocked from UPDATE and DELETE like the ledger.
- The released public ID is **retired, never reused**. The person's pledge record is kept for accountability and deleted on the normal retention schedule.
- **Reassign** is simply step 1 again for the same seat, with the next applicant on the list (a 6 h window during the election period).

## 3. Data model changes (proposed migration `0007_invites_pledges.sql`)

| Change | Purpose |
|---|---|
| `verifier_offers` + `seat_code`, `role`, `region_id`, `attempts int`, `claimed_by uuid`, status gains `'revoked'` | Bind each code to one seat; count guesses |
| `verifiers` + `pledged_at timestamptz` | The account is active only after the pledge |
| New `verifier_pledges` (no client access; BinchikAdmin read via a SECURITY DEFINER function) | Typed name, version, text hash, timestamp |
| New `seat_events` (append-only; public view without reasons) | Assigned / released / reassigned history |
| `pledge_texts (version pk, sha256, body, published_at)` | The exact wording each person signed |

Tests to add (positive and negative): code works once; an expired code fails; a wrong area is refused; a sixth attempt is locked out; an unpledged verifier cannot raise flags; an OpsAdmin cannot release seats; a released seat's public ID is never reissued; `seat_events` rejects UPDATE and DELETE.

## 4. Verifier pledge, version P-2026-2 (current)

_P-2026-2 (27 Oct 2026) is P-2026-1 with the top role renamed from "BinchikaAdmin" to "BinchikAdmin" in point 8; nothing else changed. A published version is never edited, so the rename is a new version. No one signed P-2026-1._

> I accept seat **[SEAT]** as a volunteer verifier for **[STATE / REGION]**.
>
> 1. **Neutrality.** I am not a member, official, candidate, agent or employee of any political party or campaign, and I will not act for one while I hold this seat.
> 2. **No reward.** I will take no payment, gift or favour for this work, and I will report at once any offer, threat or pressure meant to influence it.
> 3. **Flag, never edit.** I will raise flags only with evidence that someone else can check. I will never try to alter a result, a photo or the ledger.
> 4. **My area only.** I will act only for the state or region of my seat.
> 5. **Anonymity.** I will use only my seat number and public ID in meetings and messages. I will not share any verifier's identity, including my own, and I will not share a phone number on Binchika channels.
> 6. **Confidentiality.** I will keep reporters' data, unpublished flags and internal discussions private, and use them only for verifying.
> 7. **INEC declares.** I will never present Binchika's work as an official result or declare a winner.
> 8. **Stepping down.** If I can no longer meet this pledge, I will tell Binchika and give up my seat. I accept that the BinchikAdmin may release my seat if I break it.
>
> Typed name: ________________ · Signed (server time, WAT): ________________ · Pledge P-2026-2, SHA-256 ________________

This wording needs review by a data-protection professional together with the privacy notice before applications open (constitution §5). Any change creates a new version; nobody is ever shown as having signed wording they did not see.

## 5. Owner decisions (26 Oct 2026, all applied)

- Passwords with a magic-link fallback: **yes**.
- MFA (TOTP) required for BinchikAdmin and OpsAdmins: **yes**. This is enforced in the database (`is_admin()` / `is_superadmin()` need an `aal2` session) and in every `/api/admin/*` route. It is optional for verifiers.
- Full name collected at application: **yes**. The typed pledge name must match it, ignoring accents, capitals, spaces and hyphens.
- Code delivery: **email only**. The BinchikAdmin never sees the code.
- Turnstile: not added yet. Code guessing is limited by 39-bit codes, single use, 5 wrong claims per code and 10 failures per hashed IP per 15 minutes.

### Original questions
1. **Passwords.** The portal is passwordless today (magic link). This flow adds email + password, so: enable password sign-in in Supabase, keep the magic link as a fallback, and update the `signInLink({ reset: true })` wording, which currently says "there are no passwords".
2. **MFA.** Require authenticator-app (TOTP) MFA for the BinchikAdmin and OpsAdmins, and offer it to verifiers.
3. **Leaked-password check.** Supabase's leaked-password protection is believed to need the Pro plan (to be checked). The planned Pro upgrade on 1 Dec would cover it.
4. **Name check.** The application form does not collect a name today. Either collect a full name at application, so the pledge name can be matched, or accept any typed full name (two or more words) as the signature.
5. **Code delivery.** Email only (the current design), or also shown in the portal for the BinchikAdmin to pass on through Signal?

## 6. Build order (when approved)
1. Migration 0007 and its tests.
2. `/api/admin/invites`, `/api/join/check`, `/api/join/claim` and `/api/join/pledge`, plus the `seatConfirmation` email template.
3. The `/join/` and `/join/pledge/` pages, then Release and Reassign in the portal Seats section.
4. Turnstile and the rate limits.
5. An end-to-end test on a preview deployment with a test inbox, before production.

## 7. Session 8 additions (27 Oct 2026): code types, OpsAdmin seats, locks

Built in migration `0009_admin_lock_ops_seats_flexible_codes.sql`, with tests in `supabase/tests/lock_test.sql`.

**Three code types.** The BinchikAdmin chooses one in the portal's Seats section.

| Type | What the invitee sees at `/join/` | When to use it |
|---|---|---|
| **SZV code** | The three SZV seats of the state they applied for. Open seats can be picked; taken or reserved seats are greyed out. | The normal case: let the volunteer pick. |
| **NRV code** | The three NRV seats of the region containing their state, shown the same way. | The normal case for NRVs. |
| **Specific seat** | One exact seat. | Backfilling a particular seat. |

- **Area rule.** A code never shows seats outside the applicant's area (constitution §4a). The database refuses such a seat even if someone sends one by hand.
- **Picking a seat.** The seat is chosen at claim time and locked in the database, so two invitees can never take the same seat. If one gets there first, the other is told the seat has just been taken and the list refreshes.
- **Revoking.** An unused code of any type can be revoked from the Live invites table. The applicant becomes eligible again.
- **Applicant must match.** A code's type must match the applicant's application (SZV or NRV). The code is refused if no seat of that type is open in their area.

**OpsAdmin seats: `OPS-1`, `OPS-2` and `OPS-3`, and never more.**
- Only the BinchikAdmin appoints an OpsAdmin (`/api/admin/ops`), by email. The address must never have had a Binchika account.
- OPS seats can never be offered by invite code, and no application leads to one.
- An active OpsAdmin must hold an OPS seat (database trigger).
- An appointee gets a one-time sign-in link and must set up an authenticator app before any admin tool works.
- Release works like any seat: the account is blocked and the public ID retired.

**Locks.**
- **BinchikAdmin address.** Only the owner's address can ever hold the BinchikAdmin role. The database stores only its SHA-256 (`superadmin_lock`, which cannot be edited or deleted). A trigger refuses any other account, and `is_superadmin()` and the API both check the address again.
- **One BinchikAdmin.** There is only ever one, enforced by a unique index.
- **Roles never change.** A verifier's role is fixed, so an OpsAdmin or verifier can never be raised to BinchikAdmin, even by a direct database update.
- **Seat emails.** The email of any account bound to a seat (SZV, NRV, OPS or the BinchikAdmin) can never be changed, so no second email is ever linked to a seat while it is held. A seat's account can never be swapped for another.
- **After a release.** A released seat goes to a new person only through a fresh BinchikAdmin invite. The seat history keeps every holder's public ID for good.
