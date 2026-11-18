# Check the random sample yourself

Where every report for a polling unit agrees and few people back the figures, nothing else asks for an extra photo. So Binchika also asks for photos from a **random sample of 2 in every 100 undisputed units**. The sample never holds a unit back: a sampled unit with no photo sent is posted if its other photos meet the rule, like any unit. This page shows how anyone can check that the sample was drawn fairly, without any access to Binchika's systems: you need only the published rule, the published lists and a computer.

**Status.** Photo requests are not running yet. The worked example below uses a real past random value and a made-up list of five units, so you can try every step today. *Session 188: the owner added a published commitment to the list before the draw and removed the switch to a later round (sections 4a and 6); the rule on `/ledger/` will carry these when it is published. Session 192: one definition of "same figures", outside copies of the commitment, and the empty list (section 4a). Session 194: the election identifier in the commitment, the archive capture as the only evidence of time, and the full list published after the night window.*

**Undisputed** means: at the cut-off C (below), the polling unit has, for that race, at least one claim or report that has not been rejected; every one of them carries the same party figures (control figures are not compared; typed figures are included); and the unit is not yet posted. The same definition is used in the photo-request design. Unit codes and race names are plain ASCII text.

## What is published, and when
**Before polling day** (on the ledger page and in the code repository), the rule, which cannot be changed afterwards:
- the source: **drand `quicknet`**, a public random number run by the League of Entropy, an independent group of organisations. Binchika does not run it;
- the network's chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`, period (3 seconds), genesis time (1692803367) and public key:
  `83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a`
  (you can confirm all four at `https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/info`, which also names the scheme `bls-unchained-g1-rfc9380`);
- the **stated time T** after which the draw is made (for example, two hours after polls close);
- the **cut-off C**, at least 30 minutes before T, when the list of undisputed units is frozen;
- the SHA-256 of a fallback secret, and the fallback rule (section 6).

**Between C and T:** for each race, the **commitment**, a SHA-256 of the frozen list (section 4a). It is published before round R exists, so nobody can choose the list after seeing the random number. It is put in a plain-text file at a fixed address, `/ledger/sample-commitments.txt`, and that file is captured by a public web archive before T.

**The archive capture is the only evidence of time.** Its own timestamp shows the commitment existed before T, without trusting Binchika's clock. A copy in the open-source repository is a convenience only: a git commit's date is set by whoever commits and proves nothing.
- **"Published" means captured by the archive before T.** No capture before T for a race means **no draw for that race**.
- **Two different commitments for the same race void its draw.**

**After the draw, on the night:** the round number R used, and for each race the **sampled units**.

**After the night window closes:** for each race, the full list of **undisputed units**. It is held back until then so that, on the night, it cannot point to the units where people used the app. You can check the commitment (section 4a) as soon as the list is out.

## 1. Work out which round is used
The random number is drand round **R**, the first round at or after the stated time T (in Unix seconds):

R = (T − 1692803367) ÷ 3, **rounded up** to a whole number, plus 1

(in integer arithmetic: R = ⌊(T − 1692803367 + 2) ÷ 3⌋ + 1)

Round r is produced at 1692803367 + (r − 1) × 3 seconds. Check that the published R matches.

## 2. Fetch round R from two independent relays
```
https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/R
https://drand.cloudflare.com/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971/public/R
```
Replace `R` with the number. Each answers with `round`, `signature` and `randomness`. **The two answers must have the same three values** (the relays may list the fields in a different order; that does not matter). Keep the chain hash in the address: without it a relay answers from a different drand network.

## 3. Check the round is genuine
A relay could be wrong; the signature cannot be forged. Check two things:
1. **The signature.** Scheme `bls-unchained-g1-rfc9380` on the BLS12-381 curve:
   - the signed message is SHA-256 of the round number written as **8 bytes, big-endian**;
   - the message is hashed **to G1** with the domain tag `BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_`;
   - the **signature** is a **48-byte compressed G1 point** (96 hex characters);
   - the **public key** is a **96-byte compressed G2 point** (192 hex characters): the one in "What is published" above. Compare it with the relay's `/info` too.

   Many BLS libraries default to the opposite layout (signatures on G2, keys on G1), so choose the "short signature" or G1-signature mode. Use any drand client that supports this scheme, or the script in section 5.
2. **The randomness** is SHA-256 of the signature's bytes.

## 4. Redo the draw
For each race separately, take the published list of undisputed units (N units). Unit codes and race names are **exact, case-sensitive** strings, copied as published (for example `president`, all lower case). For each unit:
1. Write this text, exactly, with a line break (`\n`, one byte) between the four parts and no line break at the end:
   ```
   binchika-sample/1
   <unit code>
   <race>
   <randomness, 64 lower-case hex characters>
   ```
2. Encode it as UTF-8 and take its **SHA-256**, written as 64 lower-case hex characters.

Sort the units by that value, lowest first (if two values were ever equal, the lower unit code first). The sample is the first **k** units, where

k = N × 2 ÷ 100, **rounded up** to a whole number; in integer arithmetic, k = ⌊(2N + 99) ÷ 100⌋ (so N = 50 gives 1, N = 100 gives 2, N = 101 gives 3, N = 0 gives 0).

**Compare** your k units with the published sample list for that race. They must be the same units.

## 4a. Check the list was fixed before the draw
For each race, write this text, exactly, with a line break (`\n`) between the parts and none at the end:
```
binchika-undisputed/1
<election>
<race>
<first unit code>
<second unit code>
…
<last unit code>
```
with the published undisputed units **sorted in ascending order** (byte by byte, as plain ASCII text; each unit once). `<election>` is the election identifier published with the rule (for example `2027-presidential`). If the list is empty, the text is just the first three lines, with no line break after the race. Encode it as UTF-8 and take its SHA-256, as 64 lower-case hex characters. It must equal the commitment published **before** T for that race. If it differs, the list was changed after it was frozen: report it.

The commitment shows the list was not changed after the random number was known. It cannot show that the list was complete when it was frozen, because claims are never published; the request log, published after the dispute window, lets anyone compare later.

**No salt.** The text has no secret part. For a race with only a handful of undisputed units, someone could guess the list from the commitment before it is published. That is accepted: the list itself is not secret, only held back for the night.

## 5. A script that does steps 2 to 4
It needs Node.js 20 or later and one library: `npm install @noble/curves@2.4.0`. Save it as `check-sample.mjs` and run `node check-sample.mjs`. The example values are filled in; replace them with the published ones.
```js
import { bls12_381 } from "@noble/curves/bls12-381.js";
import { createHash } from "node:crypto";

const CHAIN = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
const PUBLIC_KEY = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const R = 34036698;                                   // the published round
const election = "2027-presidential";                // the election identifier published with the rule
const race = "president";                             // one race at a time
const units = ["01-01-01-001", "01-01-01-002", "01-01-02-001", "02-03-01-004", "03-02-05-010"];   // the published undisputed units
const published = ["01-01-02-001"];                   // the published sample for this race
const commitment = "3211df20c1f8dba9eda52ed0677a5561431f7333406c3c84448fdafa77732f2c";   // published before T for this race

const sha256 = (data) => createHash("sha256").update(data).digest();
const committed = sha256(["binchika-undisputed/1", election, race, ...[...new Set(units)].sort()].join("\n")).toString("hex");
if (new Set(units).size !== units.length) throw new Error("the published list repeats a unit");
console.log(committed === commitment ? "list: matches the commitment" : "list: DOES NOT MATCH the commitment: report it");
const [a, b] = await Promise.all(["https://api.drand.sh", "https://drand.cloudflare.com"]
  .map((relay) => fetch(`${relay}/${CHAIN}/public/${R}`).then((r) => r.json())));
if (["round", "signature", "randomness"].some((f) => a[f] !== b[f])) throw new Error("the two relays disagree");

const round = Buffer.alloc(8); round.writeBigUInt64BE(BigInt(R));
const message = bls12_381.shortSignatures.hash(sha256(round), DST);
const genuine = bls12_381.shortSignatures.verify(Buffer.from(a.signature, "hex"), message, Buffer.from(PUBLIC_KEY, "hex"));
const randomnessOk = sha256(Buffer.from(a.signature, "hex")).toString("hex") === a.randomness;
console.log(`round ${a.round}: signature ${genuine ? "valid" : "INVALID"}, randomness ${randomnessOk ? "matches" : "DOES NOT MATCH"}`);

const ranked = units
  .map((unit) => ({ unit, digest: sha256(`binchika-sample/1\n${unit}\n${race}\n${a.randomness}`).toString("hex") }))
  .sort((x, y) => (x.digest < y.digest ? -1 : x.digest > y.digest ? 1 : x.unit < y.unit ? -1 : 1));
const k = Math.floor((units.length * 2 + 99) / 100);   // 2% of N, rounded up, in whole numbers
const mine = ranked.slice(0, k).map((r) => r.unit);
ranked.forEach((r, i) => console.log(`${i + 1}. ${r.unit} ${r.digest}${i < k ? "  <- sampled" : ""}`));
const a1 = [...mine].sort(), a2 = [...published].sort();      // compare as sorted lists, so a repeated unit cannot pass
const same = a1.length === a2.length && a1.every((u, i) => u === a2[i]);
console.log(same ? "MATCH: the published sample is correct" : "MISMATCH: report it");
```

## Worked example
A real drand round (produced on 17 November 2026, when this page was written) and five made-up units, race `president`:
- **Stated time** T = 1794913458 (17 November 2026, 11:04:18 UTC). R = (1794913458 − 1692803367) ÷ 3 = 34036697 exactly, rounded up stays 34036697, plus 1 = **34036698**. Round 34036698 is produced at exactly T.
- **Round 34036698** from either relay:
  `signature` = `91a22934857482285602b9edeba01b016aa698d08043b81c89c7894968ec8ea43424d603a2b61a6d0d304199ab8e8344`
  `randomness` = `c9a35dffa5f63353289f82c41b422dd80738359d79cab8196372f9243787563f` (= SHA-256 of the signature bytes).
- **The commitment** for these five units, election `2027-presidential` and race `president` (section 4a): `3211df20c1f8dba9eda52ed0677a5561431f7333406c3c84448fdafa77732f2c`. Leave out any one unit and it changes. Without `03-02-05-010`, for example, it is `52b9d0e287488a5ad551ce8ab61dbd8f539afe69cb2ec3e15cb19fb1bee0ca48`. With an empty list it is `e2f7b62f44fa7beb3e70b2409587303413e4af0534f6ec64e141035affeb4b17`.
- **The five units**, N = 5, so k = 5 × 2 ÷ 100 = 0.1, rounded up = **1**:

| Rank | Unit | SHA-256 of the text in section 4 |
|---|---|---|
| 1 | `01-01-02-001` | `171303bf87b1213334fd1b25c8a701f0705298bf99c2304346832d81338fa354` ← **sampled** |
| 2 | `02-03-01-004` | `187db9bf0fca9681392039a088e1f8f3bf858b07f6c18c7b4923875cd68aa6a9` |
| 3 | `01-01-01-001` | `646506f4357fe78606d2fd90422ef10512b625845830e258165c585f37881998` |
| 4 | `01-01-01-002` | `701e79317b2571b295e043b6cea7674a11f27cd60743857ead35450065d0a33a` |
| 5 | `03-02-05-010` | `ab564c7e97f77e2a5cae602518acc49afe59fe30873d6b322c65853912ebbd49` |

So the sample for this example is `01-01-02-001`.

## 6. If the fallback was used
**There is no switch to a later round.** Binchika waits for round R itself. Only if round R cannot be fetched and verified within 24 hours of T is a **secret** prepared before polling day used instead (owner decision, session 188; this replaces the earlier "next round within 6 hours" step). If the ledger says the secret was used:
1. Check that SHA-256 of the revealed secret (its bytes, as published in hex) equals the hash published **before** polling day.
2. Redo section 4 with the secret's hex in place of the randomness.

Whoever held the secret could have known the sample in advance. The rule says so publicly, which is why the drand round comes first. **To spot misuse:** if the ledger says the secret was used but you can fetch and verify round R from either relay (section 2), the published rule was broken: report it.

## 7. If your result differs
Check the four parts of the text and the line breaks first: one extra space changes every value. If it still differs, report it through the contact form on the site, with the race, R and your list. A wrong sample is a fault in Binchika's published record, and it will be answered publicly on the ledger.
