// Read-only browser checks and matched home captures. No API writes or account actions.
// node scripts/check-home.mjs https://binchika.com before [--perf]
import assert from 'node:assert/strict';
import {mkdir, writeFile, readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import puppeteer, {PredefinedNetworkConditions} from 'puppeteer-core';

const base = new URL(process.argv[2] ?? 'https://binchika.com');
assert.ok(['http:', 'https:'].includes(base.protocol), 'HTTP(S) target required');
const stage = process.argv[3] ?? 'preview';
assert.ok(['before', 'preview', 'after'].includes(stage), 'known capture stage required');
const rootFlag=process.argv.indexOf('--output-root');
const outputRoot=rootFlag<0?resolve('output/home-session94'):resolve(process.argv[rootFlag+1]??'.');
const outputRelative=relative(resolve('output'),outputRoot);
assert.ok(outputRelative&&!outputRelative.startsWith('..')&&!isAbsolute(outputRelative),'captures must stay in a task folder under project output');
const dir = resolve(outputRoot, stage);
await mkdir(dir, {recursive: true});
const baselinePath = resolve('docs/egm/home-3d/verification/protected-sources.json');
async function sourceHashes() {
  const rows = [];
  async function walk(path) {
    for (const entry of await readdir(path, {withFileTypes:true})) {
      const file = path + '/' + entry.name;
      if(entry.isDirectory()) await walk(file);
      else if(entry.isFile() && file !== 'src/pages/index.html' && file !== 'site/assets/js/home.js') {
        let bytes = await readFile(file);
        // The sole authorised change to the retained world-map code.
        if(file === 'site/assets/js/world.js') bytes = Buffer.from(bytes.toString().replace('from indigenous primary sources first', 'from African primary sources first'));
        rows.push({path:file, hash:createHash('sha256').update(bytes).digest('hex')});
      }
    }
  }
  for(const path of ['functions','workers','ledger','data','site/data','src/pages','site/assets/js']) await walk(path);
  return rows.sort((a,b) => a.path.localeCompare(b.path));
}
if(stage === 'before') {
  try {await readFile(baselinePath);}
  catch {
    await writeFile(baselinePath, JSON.stringify(await sourceHashes(),null,2)+'\n');
    await writeFile(resolve('output/home-session94/before-home.html'), await readFile('src/pages/index.html'));
  }
} else {
  const baseline = JSON.parse(await readFile(baselinePath,'utf8'));
  assert.deepEqual(await sourceHashes(),baseline,'all protected sources/data unchanged except exact history wording');
  const original = await readFile(resolve('docs/egm/home-3d/verification/before-home.html'),'utf8');
  const current = await readFile('src/pages/index.html','utf8');
  const retained = [...original.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].slice(1);
  for(const section of retained) assert.ok(current.includes(section[1]),'complete original non-hero section content retained');
  console.log(`PASS ${baseline.length} protected source hashes and ${retained.length} complete original non-hero sections`);
}
if(process.argv.includes('--integrity-only')) {console.log('PASS protected-source baseline/check');process.exit(0);}
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  userDataDir: resolve('tmp/chrome-home94-check'), headless: true,
  args: ['--disable-crash-reporter', '--disable-breakpad'],
});
const evidence = {base: base.origin, stage, capturedAt: new Date().toISOString(), checks: [], metrics: []};
function check(value, label) {assert.ok(value, label); evidence.checks.push(label);}

async function open(viewport, {reduced = true, javascript = true, lowEnd = false} = {}) {
  const page = await browser.newPage();
  await page.setViewport({...viewport, deviceScaleFactor: 1});
  await page.emulateMediaFeatures([{name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference'}, {name: 'prefers-color-scheme', value: 'light'}]);
  if (!javascript) await page.setJavaScriptEnabled(false);
  if (lowEnd) await page.evaluateOnNewDocument(() => {Object.defineProperty(navigator,'deviceMemory',{value:2});Object.defineProperty(navigator,'connection',{value:{saveData:true}});});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base.href, {waitUntil: 'networkidle2', timeout: 60000});
  if (javascript) {
    await page.waitForSelector('#world > svg', {timeout: 20000});
    await page.evaluate(async () => document.fonts.ready);
  }
  return {page, errors};
}

try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    const {page, errors} = await open({width, height, isMobile: name === 'mobile', hasTouch: name === 'mobile'});
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal overflow`);
    check(await page.$$eval('[data-countdown]', nodes => nodes.map(n => n.dataset.countdown).join('|')) === '2027-01-16T00:00:00+01:00|2027-02-06T00:00:00+01:00', `${name}: both original election clocks`);
    check(await page.$$eval('[data-u="s"]', nodes => nodes.every(n => /^\d{2}$/.test(n.textContent))), `${name}: both clocks run`);
    check(await page.$eval('#country-pick', el => el.options.length > 150), `${name}: complete country picker`);
    for (const id of ['news-reel', 'how-h', 'scale-h', 'demo-grid', 'pledge-h']) check(!!await page.$('#' + id), `${name}: retained ${id}`);
    check(await page.$eval('.launch-banner', el => el.textContent.includes('Thursday 5 November 2026') && el.textContent.includes('readiness testing is ongoing')), `${name}: launch and readiness banner`);
    if (stage !== 'before') {
      check(await page.$$eval('[data-evidence-card]', els => els.length) === 3, `${name}: three evidence cards`);
      check(await page.$eval('.home-art-note', el => el.textContent.includes('not an election photograph')), `${name}: artwork labelled`);
      check(await page.$eval('.home-closed', el => /closed/.test(el.textContent) && /OCR is off/.test(el.textContent) && /not yet in force/.test(el.textContent)), `${name}: closed state explicit`);
      let uncovered = true;
      for (const text of await page.$$('.home-card-title, .home-card-copy')) {
        uncovered &&= await text.evaluate(el => {el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit?.closest('[data-evidence-card]')===el.closest('[data-evidence-card]');});
      }
      check(uncovered, `${name}: card text is not covered by another card`);
      for (const key of ['compare', 'ledger', 'photo']) {
        await page.$eval(`[data-evidence-card="${key}"]`, el => el.click());
        check(await page.$eval(`[data-evidence-card="${key}"]`, el => el.getAttribute('aria-pressed')) === 'true', `${name}: ${key} selection works`);
      }
      await page.focus('[data-evidence-card="compare"]'); await page.keyboard.press('Space');
      check(await page.$eval('[data-evidence-card="compare"]', el => el.getAttribute('aria-pressed')) === 'true', `${name}: Space activates card`);
      check(await page.$eval('[data-depth-pause]', el => el.hidden), `${name}: reduced motion disables depth`);
      await page.select('#country-pick', '566');
      await page.waitForFunction(() => !document.querySelector('.country-panel').hidden && !!document.querySelector('.country-panel .more-btn'));
      await page.$eval('.country-panel .more-btn', el => el.click());
      check(await page.$eval('.country-panel', el => el.textContent.includes('indigenous primary sources first')), `${name}: requested history wording`);
      await page.keyboard.press('Escape');
      check(await page.$eval('.country-panel', el => el.hidden), `${name}: map Escape resets`);
      await page.$eval('[data-evidence-card="photo"]', el => el.click());
    }
    await page.evaluate(async () => {
      document.activeElement?.blur();
      for(const section of document.querySelectorAll('main > section')) {
        section.scrollIntoView({block:'start',behavior:'instant'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      }
      scrollTo(0,0);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    await page.screenshot({path: resolve(dir, name + '.png'), fullPage: true});
    await page.screenshot({path: resolve(dir, name + '-first-screen.png')});
    if (stage !== 'before') {
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
      await new Promise(resolve => setTimeout(resolve, 350));
      await page.screenshot({path: resolve(dir, name + '-dark.png')});
    }
    check(errors.length === 0, `${name}: no runtime errors`);
    await page.close();
  }
  if (stage !== 'before') {
    for (const width of [320, 768]) {
      const {page} = await open({width, height: 900});
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px: no overflow`);
      check(await page.$$eval('[data-evidence-card]', els => els.every(el => {const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44;})), `${width}px: accessible card targets`);
      await page.close();
    }
    const {page: staticPage} = await open({width: 390, height: 844}, {javascript: false});
    check(await staticPage.$$eval('[data-evidence-card]', els => els.length) === 3, 'no JS: all three cards exist');
    check(await staticPage.$eval('.home-hero', el => el.textContent.includes('Only INEC declares results')), 'no JS: purpose and authority visible');
    check(await staticPage.$eval('.home-card-copy', el => getComputedStyle(el).display !== 'none'), 'no JS: card explanation visible');
    check(await staticPage.$eval('.home-jumps a', el => el.getAttribute('href')) === '#world-heading', 'no JS: standard map anchor');
    await staticPage.close();
    const {page} = await open({width: 1440, height: 1000}, {reduced: false});
    const enabled = await page.$eval('[data-depth-pause]', el => !el.hidden);
    if (enabled) {
      const r = await page.$eval('[data-evidence-scene]', el => {const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height};});
      await page.mouse.move(r.x + r.width * .75, r.y + r.height * .6);
      await new Promise(resolve => setTimeout(resolve, 120));
      check(await page.$eval('[data-evidence-scene]', el => !!el.style.getPropertyValue('--scene-ry')), 'fine pointer: depth responds');
      await page.click('[data-depth-pause]');
      check(await page.$eval('[data-depth-pause]', el => el.getAttribute('aria-pressed')) === 'true', 'depth pause works');
      check(await page.$eval('[data-evidence-scene]', el => !el.style.getPropertyValue('--scene-ry')), 'paused depth is reset');
    }
    await page.close();
    const {page: lowPage} = await open({width:1440,height:1000}, {reduced:false,lowEnd:true});
    check(await lowPage.$eval('[data-depth-pause]', el => el.hidden), 'save-data/low-memory: depth stays off');
    await lowPage.$eval('[data-evidence-card="ledger"]',el=>el.click());
    check(await lowPage.$eval('[data-evidence-card="ledger"]',el=>el.getAttribute('aria-pressed'))==='true','save-data/low-memory: card selection still works');
    await lowPage.close();
  }
  if (process.argv.includes('--perf') || (stage !== 'before' && !process.argv.includes('--functional-only'))) {
    for (let run = 1; run <= 3; run++) {
      const page = await browser.newPage();
      await page.setViewport({width: 390, height: 844, deviceScaleFactor: 1, isMobile: true});
      const cdp = await page.createCDPSession();
      await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', {cacheDisabled: true});
      await page.emulateNetworkConditions(PredefinedNetworkConditions['Slow 4G']);
      await page.emulateCPUThrottling(4);
      let bytes = 0, requests = 0;
      cdp.on('Network.loadingFinished', e => bytes += e.encodedDataLength);
      cdp.on('Network.requestWillBeSent', () => requests++);
      await page.evaluateOnNewDocument(() => {
        window.__homePerf = {lcp: 0, cls: 0, longTasks: 0, blockingMs: 0};
        new PerformanceObserver(list => {for (const e of list.getEntries()) window.__homePerf.lcp = e.startTime;}).observe({type:'largest-contentful-paint', buffered:true});
        new PerformanceObserver(list => {for (const e of list.getEntries()) if(!e.hadRecentInput) window.__homePerf.cls += e.value;}).observe({type:'layout-shift', buffered:true});
        new PerformanceObserver(list => {for (const e of list.getEntries()) {window.__homePerf.longTasks++; window.__homePerf.blockingMs += Math.max(0, e.duration - 50);}}).observe({type:'longtask', buffered:true});
      });
      await page.goto(base.href, {waitUntil:'networkidle2',timeout:120000});
      await new Promise(resolve => setTimeout(resolve, 1500));
      const perf = await page.evaluate(() => window.__homePerf);
      evidence.metrics.push({run,...perf,bytes,requests});
      console.log(`Mobile run ${run}: LCP ${Math.round(perf.lcp)}ms; CLS ${perf.cls.toFixed(4)}; blocking ${Math.round(perf.blockingMs)}ms; ${Math.round(bytes/1024)}KiB`);
      await page.close();
    }
    const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
    evidence.medians = Object.fromEntries(['lcp','cls','blockingMs','bytes'].map(key=>[key,median(evidence.metrics.map(row=>row[key]))]));
    if(stage!=='before') {
      const baseline = JSON.parse(await readFile(resolve('docs/egm/home-3d/verification/before-browser.json'),'utf8'));
      const previous = key => median(baseline.metrics.map(row=>row[key]));
      check(evidence.medians.lcp <= previous('lcp') + Math.max(200, previous('lcp')*.1), 'mobile median LCP stays within baseline + max(200ms,10%)');
      check(evidence.metrics.every(row=>row.cls <= .1), 'all mobile CLS runs stay <=0.1');
      check(evidence.medians.blockingMs <= previous('blockingMs') + 100, 'mobile median blocking stays within baseline +100ms');
      evidence.lcpTargetMet = evidence.medians.lcp <= 2500;
      console.log(`Mobile median: LCP ${Math.round(evidence.medians.lcp)}ms; 2.5s target ${evidence.lcpTargetMet?'met':'not met (see no-regression gate)'}`);
    }
  }
  if(!process.argv.includes('--snapshots-only')) await writeFile(resolve(dir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`PASS ${evidence.checks.length} home checks; ${stage} screenshots and evidence in ${dir}`);
} finally {await browser.close();}
