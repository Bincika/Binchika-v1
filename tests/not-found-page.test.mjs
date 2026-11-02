import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Session 91 (owner-approved): scripts/build-site.mjs writes src/pages/404.html to site/404.html. Cloudflare Pages serves
// that file with a 404 status for any address that matches no file or Function. Run after a build.
test("site/404.html is branded, links to / and /vote/, is noindex and is left out of the sitemap", () => {
  const html = readFileSync("site/404.html", "utf8");
  assert.match(html, /<title>Page not found · Binchika<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.ok(!html.includes('rel="canonical"'), "no canonical URL on the error page");
  assert.ok(html.includes('class="btn btn-solid" href="/"') && html.includes('href="/vote/"'));
  assert.ok(html.includes('Only <a href="https://www.inecnigeria.org/"'), "INEC notice in the masthead");
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(html));
  assert.ok(!readFileSync("site/sitemap.xml", "utf8").includes("404"));
});
