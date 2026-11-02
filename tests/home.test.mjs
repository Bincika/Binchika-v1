import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('src/pages/index.html');

test('home retains the public information and integration hooks', () => {
  for (const id of ['world', 'country-pick', 'news-reel', 'news-live', 'how-h', 'scale-h', 'demo-grid', 'dg-sex', 'dg-age', 'pledge-h']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const key of ['in', 'out', 'reset']) assert.match(html, new RegExp(`data-zoom="${key}"`));
  assert.deepEqual([...html.matchAll(/data-countdown="([^"]+)"/g)].map(m => m[1]), ['2027-01-16T00:00:00+01:00', '2027-02-06T00:00:00+01:00']);
  for (const phrase of ['Public launch: Thursday 5 November 2026.', 'Site readiness testing is ongoing.', '{{PIPELINE}}', '{{EC8A_RULE}}', 'An untransparent election is', 'a selection!', 'Mu bincika tare', 'let us examine it together', 'News reel', 'The scale', 'Neutrality pledge', 'No party gets a louder voice.', '0 of 176,846 polling units reported', '93,469,008', 'All 22 INEC-registered parties', 'No advertising, ever', 'Equal space for all parties', 'Anyone can audit it']) assert.ok(html.includes(phrase), phrase);
  assert.equal((html.match(/<li class="step"/g) ?? []).length, 5);
  for (const src of ['/assets/js/world.js', '/assets/js/news.js']) assert.ok(html.includes(src));
});

test('three evidence cards remain usable HTML with exclusive initial selection', () => {
  const cards = [...html.matchAll(/<button\b[^>]*data-evidence-card="([^"]+)"[^>]*>/g)];
  assert.deepEqual(cards.map(m => m[1]), ['photo', 'compare', 'ledger']);
  assert.equal(cards.filter(m => /aria-pressed="true"/.test(m[0])).length, 1);
  assert.match(cards[0][0], /aria-pressed="true"/);
  assert.equal((html.match(/class="home-card-copy"/g) ?? []).length, 3);
  assert.match(html, /data-depth-pause[^>]*hidden/);
  assert.match(html, /class="home-art-note"/);
  assert.match(html, /not an election photograph/);
  assert.match(html, /class="home-closed"/);
  assert.match(html, /OCR is off/);
  assert.match(html, /not yet in force/);
  assert.doesNotMatch(html, /<form\b|type="email"|autoplay|<canvas\b/);
  assert.match(html, /href="\/contact\/">Contact Binchika/);
});

test('history and culture uses the exact owner-requested indigenous wording', () => {
  const world = read('site/assets/js/world.js');
  assert.match(world, /Being written<\/span> from indigenous primary sources first, with citations\. We do not reuse foreign-government narratives here\./);
  assert.doesNotMatch(world, /Being written<\/span> from African primary sources/);
});

test('home enhancement stays local and within its asset budgets', () => {
  const js = read('site/assets/js/home.js'), css = read('site/assets/css/home.css');
  assert.ok(Buffer.byteLength(js) <= 8192, 'JS ≤8KiB');
  assert.ok(Buffer.byteLength(css) <= 18432, 'CSS ≤18KiB');
  assert.ok(statSync(new URL('../site/assets/img/home/civic-portrait.webp', import.meta.url)).size <= 102400, 'artwork ≤100KiB');
  assert.doesNotMatch(js, /fetch\s*\(|localStorage|sessionStorage|setInterval|WebGL|three\.js/);
  assert.match(js, /prefers-reduced-motion/);
  assert.match(js, /saveData/);
  assert.match(css, /prefers-reduced-motion/);
});
