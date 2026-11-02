// Append-only, hash-chained ledger entries. WebCrypto only, so it runs in Workers and Node 20+.

const enc = new TextEncoder();

export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", typeof input === "string" ? enc.encode(input) : input);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable JSON: object keys sorted recursively, so the same content always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const genesis = (cycle) => sha256Hex(`binchika-ledger-genesis:${cycle}`);

/** Returns a new entry chained to `prev` (hex hash). `hash` covers everything except itself. */
export async function makeEntry(body, prev, recordedAt = new Date().toISOString()) {
  const { hash: _drop, ...rest } = body;
  const entry = { ...rest, prev, recordedAt };
  return { ...entry, hash: await sha256Hex(canonical(entry)) };
}

/** Verifies an ordered chain. Returns { ok, brokenAt } (index of first bad entry, or -1). */
export async function verifyChain(entries, genesisHash) {
  let prev = genesisHash;
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...rest } = entries[i];
    if (rest.prev !== prev || (await sha256Hex(canonical(rest))) !== hash) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, brokenAt: -1 };
}
