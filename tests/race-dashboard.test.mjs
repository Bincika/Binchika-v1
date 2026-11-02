import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as art from '../site/assets/js/lib/race-art.js';

let api = {};
try { api = await import('../site/assets/js/lib/race-dashboard.js'); } catch {}
const parties = Array.from({length: 22}, (_, i) => ({ acronym: `P${String(i).padStart(2, '0')}`, name: `Test party ${i}` }));
const states = JSON.parse(readFileSync(new URL('../site/data/states.json',import.meta.url))).states;
const raceRules = JSON.parse(readFileSync(new URL('../site/data/races.json',import.meta.url))).races;

test('28-state exclusion applies only to governorship; other scopes remain distinct', () => {
  assert.equal(typeof api.eligibleStates,'function');
  const governor=api.eligibleStates('governor',states,raceRules);
  assert.equal(governor.length,28);
  assert.ok(!governor.some(s=>s.iso==='NG-AN'||s.iso==='NG-FC'));
  const assembly=api.eligibleStates('state-assembly',states,raceRules);
  assert.equal(assembly.length,36);assert.ok(assembly.some(s=>s.iso==='NG-AN'));
  assert.equal(api.eligibleStates('local-government',states,raceRules).length,36);
  assert.equal(api.eligibleStates('president',states,raceRules).length,37);
});

test('reported-state counts exclude ties and keep the FCT separate', () => {
  const data={byState:{'NG-LA':{units:3,totals:{X:20,Y:80}},'NG-KN':{units:2,totals:{X:50,Y:50}},'NG-AN':{units:4,totals:{X:75,Y:25}},'NG-FC':{units:1,totals:{X:80,Y:20}}}};
  const result=api.reportedStateCounts(data,api.eligibleStates('president',states,raceRules));
  assert.deepEqual(result.counts,{Y:1,X:1});assert.equal(result.ties,1);
  assert.equal(result.fct.party,'X');assert.equal(result.totalStates,36);
  const gov=api.reportedStateCounts(data,api.eligibleStates('governor',states,raceRules));
  assert.deepEqual(gov.counts,{Y:1});assert.equal(gov.fct,null);
});

test('25-percent reporting reference is inclusive and never claims a result', () => {
  const data={byState:{'NG-LA':{totals:{X:25,Y:75}},'NG-KN':{totals:{X:24,Y:76}},'NG-FC':{totals:{X:90,Y:10}}}};
  const ref=api.reportedSpread(data,api.eligibleStates('president',states,raceRules),'X');
  assert.equal(ref.states,1);assert.equal(ref.fct,true);
  assert.equal(api.reportedSpread({byState:{}},states,'X').states,0);
});

test('Senate and House artwork has exactly109/360 unassigned seats', () => {
  assert.equal(typeof art.seatChamber,'function');
  for(const n of [109,360]) {
    const svg=art.seatChamber(n);
    assert.equal((svg.match(/<circle /g)||[]).length,n);
    assert.ok(svg.includes('Unassigned'));
  }
});

test('all six races have their own dashboard view', () => {
  assert.ok(api.DASHBOARD_RACES, 'Six-race view definitions are available');
  assert.deepEqual(Object.keys(api.DASHBOARD_RACES), ['president','senate','house','governor','state-assembly','local-government']);
});

test('approved state and local pictures use their exact original artwork cells', () => {
  assert.equal(typeof art.civicPicture, 'function');
  for (const [race,cell,viewBox] of [['governor',3,'0 512 512 512'],['state-assembly',4,'512 512 512 512'],['local-government',5,'1024 512 512 512']]) {
    assert.equal(api.DASHBOARD_RACES[race].picture, cell);
    assert.ok(art.civicPicture(cell).includes(`viewBox="${viewBox}"`));
    assert.ok(art.civicPicture(cell).includes('/assets/img/dashboard/nigerian-civic-art.webp'));
  }
});

// CI checks out one commit only (actions/checkout, fetch-depth 1), so these checks compare with SHA-256 values taken from
// the reference commits (session 97) instead of reading git history. Same byte-for-byte guarantee; no history needed.
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
test('the approved public artwork is unchanged from session 83', () => {
  // 006802a:site/assets/img/dashboard/nigerian-civic-art.webp (214,496 bytes)
  assert.equal(sha256(readFileSync(new URL('../site/assets/img/dashboard/nigerian-civic-art.webp',import.meta.url))), '4bb18adeee4807c9107dcd1255151e76348154b96de5410e95a804a65bcdb64f');
});

test('five default bars keep the full denominator and all 22 parties', () => {
  assert.equal(typeof api.dashboardRows, 'function');
  const totals = Object.fromEntries(parties.map((p, i) => [p.acronym, 22 - i]));
  const view = api.dashboardRows(parties, totals, {limit: 5});
  assert.equal(view.all.length, 22);
  assert.equal(view.visible.length, 5);
  assert.equal(view.sum, 253);
  assert.equal(view.visible[0].votes, 22);
});

test('hiding a party or small shares never changes its denominator', () => {
  const totals = {P00: 90, P01: 6, P02: 4};
  const v = api.dashboardRows(parties, totals, {hideSmall: true, hidden: new Set(['P00']), limit: 22});
  assert.equal(v.sum, 100);
  assert.deepEqual(v.visible.map(p => p.acronym), ['P01']);
  assert.equal(v.visible[0].share, .06);
});

test('new incoming acronyms appear without being passed off as verified parties', () => {
  const v = api.dashboardRows(parties, {P00: 5, NEW: 10});
  assert.equal(v.all.length, 23);
  assert.equal(v.all.find(p => p.acronym === 'NEW').registered, false);
  assert.equal(v.sum, 15);
});

test('empty, negative, non-numeric and unsafe totals are handled explicitly', () => {
  assert.equal(api.dashboardRows(parties, {}).sum, 0);
  for (const votes of [-1, NaN, Infinity, '50', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => api.dashboardRows(parties, {P00: votes}), /Invalid/);
  }
});

test('chamber percentage dots total 100, with no seat inference or renormalisation', () => {
  const v = api.dashboardRows(parties, {P00: 51, P01: 33, P02: 16}, {hidden: new Set(['P00'])});
  const dots = api.shareDots(v.all);
  assert.equal(dots.length, 100);
  assert.equal(dots.filter(p => p === 'P00').length, 51);
  assert.equal(dots.filter(p => p === 'P01').length, 33);
  assert.deepEqual(api.shareDots(api.dashboardRows(parties, {}).all), Array(100).fill(null));
});

test('existing page content outside the dashboard is retained byte for byte', () => {
  // Reference: 0f2d138:src/pages/tally.html, i.e. the tail from the first padding-top section (13,228 characters) and the
  // page head up to the session 53 comment (651 characters). The repository forces LF line endings (.gitattributes).
  const after = readFileSync(new URL('../src/pages/tally.html', import.meta.url), 'utf8');
  const tail = '<section style="padding-top:1rem">';
  assert.ok(after.includes(tail) && after.includes('<section class="page-head"') && after.includes('<!-- Session 53:'));
  assert.equal(sha256(after.slice(after.indexOf(tail))), '1c6d0ce651c0fd213e7d6f7cfe84a6abeb28a202bbc86063b2c0a1b3c9628366');
  assert.equal(sha256(after.slice(after.indexOf('<section class="page-head"'), after.indexOf('<!-- Session 53:'))), 'b34b4ec15eaa9886bea95a56cfe12f7cb060837c5dc3bbea3f3dedbe422de443');
});
