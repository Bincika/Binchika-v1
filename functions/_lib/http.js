// Small HTTP helpers for Pages Functions (session 90).
// A POST-only route without a GET handler falls through to the static site, and with no site/404.html Cloudflare Pages
// answers with the home page and status 200 (the known soft 404). An API client could mistake that for success, so
// write routes answer GET with 405 and "Allow: POST" instead. Fixed text; it reads nothing and opens nothing.
export function methodNotAllowed(allow = "POST") {
  return new Response(JSON.stringify({ error: "method not allowed", allow }), {
    status: 405,
    headers: { allow, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

// ---------- One refusal for closed intake routes (session 151; audit of 16 November 2026) ----------
// A caller without the right secret gets the same answer whether or not the route's secret is set, so the answer
// reveals nothing about configuration. What is and is not set is shown only in the owner's Diagnostics.

/**
 * Compare a presented secret with the expected one. Both are hashed and every byte is compared, so the work done does
 * not depend on where they differ or on whether a secret is configured. An empty or missing expected value never
 * matches, not even an empty presented value.
 */
export async function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(String(s ?? "")))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = expected ? 0 : 1;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

/** The one fixed answer: 401, the same bytes and headers every time. */
export function unauthorised() {
  return new Response('{"error":"unauthorised"}', {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
