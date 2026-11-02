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
