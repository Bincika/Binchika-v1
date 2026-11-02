// Real Chrome checks. Fixtures intercept this browser's read requests only.
// Usage: node scripts/check-race-dashboard.mjs local|https://preview --fixtures
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
const target=process.argv[2]??'local', fixtures=process.argv.includes('--fixtures');
const evidence=resolve('output/tally-dashboard-session85/checks'); await mkdir(evidence,{recursive:true});
let server, base=target, mode='normal', fixtureVotes=100;
if(target==='local'){
  const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
  server=createServer(async(req,res)=>{try{let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path.endsWith('/'))path+='index.html';const file=resolve('site','.'+path);if(!file.startsWith(resolve('site')+'/')&&!file.startsWith(resolve('site')+'\\'))throw Error();const bytes=await readFile(file);res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream'});res.end(bytes);}catch{res.writeHead(404);res.end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
}
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let checks=0;const errors=[];
const check=(value,label)=>{assert.ok(value,label);console.log('PASS '+label);checks++;};
try{
  const page=await browser.newPage();await page.setViewport({width:1440,height:1100,deviceScaleFactor:1});
  page.on('pageerror',e=>errors.push(e.message));
  await page.evaluateOnNewDocument(()=>{window.__cls=0;window.__snapshotText=[];new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__cls+=e.value;}).observe({type:'layout-shift',buffered:true});const original=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__snapshotText.push(text);return original.call(this,text,...args);};});
  if(fixtures){await page.setRequestInterception(true);page.on('request',async req=>{if(req.isInterceptResolutionHandled())return;const u=new URL(req.url());if(u.pathname==='/api/results'){
      if(mode==='failure')return req.respond({status:503,contentType:'application/json',body:'{}'});
      const race=u.searchParams.get('race')??'president';if(mode==='delayed'&&race==='senate')await new Promise(r=>setTimeout(r,500));
      if(mode==='slow-house'&&race==='house')await new Promise(r=>setTimeout(r,1800));
      const parties=JSON.parse(await readFile('site/data/parties.json','utf8')).parties;
      const totals=Object.fromEntries(parties.map((p,i)=>[p.acronym,Math.max(0,fixtureVotes-i*4)]));
      if(mode==='new-party')totals.TESTNEW=10;
      return req.respond({status:200,contentType:'application/json',body:JSON.stringify({race,units:{reported:20,total:176846},national:{totals},byState:{'NG-LA':{units:20,totals}},spread:{},updatedAt:'2026-10-30T20:00:00Z'})});
    }if(target==='local'&&u.pathname==='/api/config')return req.respond({status:200,contentType:'application/json',body:'{}'});req.continue();});}
  const session=await page.createCDPSession();await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:evidence});
  await page.goto(base+'/tally/',{waitUntil:'networkidle2',timeout:60000});
  await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh',{timeout:20000});
  check(await page.$$eval('#rd-bars li',els=>els.length)===5,'five bars by default');
  check(await page.$$eval('#rd-lineup button',els=>els.length)===22,'all 22 parties in the line-up');
  check(await page.$$eval('.race-civic-art',els=>els.length)===6,'six civic race-card illustrations');
  await page.$eval('#rd-panel',el=>el.scrollIntoView({behavior:'instant',block:'start'}));await new Promise(r=>setTimeout(r,250));await (await page.$('#rd-panel')).screenshot({path:resolve(evidence,'desktop-president.png')});
  await page.click('#rd-more');check(await page.$$eval('#rd-bars li',els=>els.length)===22,'show all parties');
  await page.click('#rd-more');
  await page.click('#rd-order');const order=await page.$$eval('#rd-lineup button',els=>els.map(e=>e.dataset.party));check(JSON.stringify(order)===JSON.stringify([...order].sort()),'A–Z party order');
  await page.click('[data-race="senate"]');await page.waitForFunction(()=>document.querySelector('#rd-panel').classList.contains('rd-senate')&&document.querySelector('#rd-sync').dataset.state==='fresh');
  check(await page.$eval('#rd-art',el=>el.querySelectorAll('circle').length)===109,'Senate chamber has exactly109 structural seats');
  if(fixtures){await page.click('#rd-lineup button');check(await page.$eval('#rd-art',el=>el.querySelectorAll('circle').length)===109,'hiding a party never fabricates or removes seats');}
  const remaining=await page.$$eval('#rd-lineup button[aria-pressed="true"]',els=>els.map(e=>e.dataset.party));for(const name of remaining)await page.click(`#rd-lineup [data-party="${name}"]`);
  check(await page.$$eval('#rd-bars li',els=>els.length)===0,'all parties can be hidden');
  await page.click('#rd-reset');check(await page.$$eval('#rd-bars li',els=>els.length)===5,'reset restores five bars');
  await page.click('#rd-tab-senate');await page.focus('#rd-tab-senate');await page.keyboard.press('ArrowRight');
  await page.waitForFunction(()=>document.querySelector('#rd-panel').classList.contains('rd-house')&&document.querySelector('#rd-sync').dataset.state==='fresh');
  check(await page.$eval('#race-pick',el=>el.value)==='house','keyboard tab selection synchronises race picker');
  check(await page.$eval('#rd-tab-house',el=>el.getAttribute('aria-selected'))==='true','keyboard tab state');
  await (await page.$('#rd-panel')).screenshot({path:resolve(evidence,'desktop-house.png')});
  await page.click('[data-race="local-government"]');await page.waitForFunction(()=>document.querySelector('#race-title').textContent==='Local Government');
  check(await page.$eval('#rd-selection',el=>!el.hidden&&el.textContent.includes('SIECs')),'local race keeps a clear SIEC notice');
  check(await page.$eval('#rd-panel',el=>el.classList.contains('rd-local-government')),'Local Government has its own dashboard');
  check(await page.$eval('#rd-sync',el=>el.dataset.state)==='not-connected','local reporting feed has a truthful pending state');
  await page.click('#rd-tab-president');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');
  if(fixtures){
    await page.click('#rd-hide');const count=await page.$$eval('#rd-bars li',els=>els.length);check(count<=5,'small-share filter keeps compact bars');await page.click('#rd-hide');
    const before=await page.$eval('#rd-votes',el=>el.textContent);fixtureVotes=200;await page.click('#rd-refresh');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');check((await page.$eval('#rd-votes',el=>el.textContent))!==before,'refresh updates totals');
    mode='failure';const last=await page.$eval('#rd-time',el=>el.dateTime);await page.click('#rd-refresh');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='stale');check(await page.$eval('#rd-time',el=>el.dateTime)===last,'failed refresh retains original timestamp');
    check(await page.$eval('#rd-time',el=>el.textContent.includes('refresh failed')),'failed refresh is visible');
    mode='new-party';await page.click('#rd-refresh');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');check(await page.$$eval('#rd-lineup button',els=>els.length)===23,'new tally acronym appears automatically');
    check(await page.$eval('#rd-table',el=>el.textContent.includes('unverified')),'unknown party remains explicitly unverified');
    mode='delayed';await page.click('#rd-tab-senate');await page.click('#rd-tab-house');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');await new Promise(r=>setTimeout(r,700));check(await page.$eval('#rd-race',el=>el.textContent.includes('House')),'rapid switching rejects stale responses');
    await page.click('#rd-tab-senate');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');mode='slow-house';
    await page.click('#rd-tab-house');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');await page.click('#rd-refresh');await page.click('[data-race="local-government"]');await new Promise(r=>setTimeout(r,2200));
    check(await page.$eval('#race-pick',el=>el.value)==='local-government','a slow tab response cannot override a newer local race selection');
    check(await page.$eval('#rd-selection',el=>!el.hidden&&el.textContent.includes('SIECs')),'SIEC notice survives a slow tab response');
    mode='normal';
    await page.click('#rd-tab-house');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');
  }
  await page.click('#rd-snap');await page.waitForFunction(()=>document.querySelector('#rd-status').textContent.startsWith('Snapshot saved'),{timeout:20000});
  const text=await page.evaluate(()=>window.__snapshotText.join('\n'));check(text.includes('Only INEC declares results.')&&text.includes('Saved ')&&text.includes('Data received '),'snapshot contains both timestamps and disclaimer');
  await new Promise(r=>setTimeout(r,800));const downloaded=(await readdir(evidence)).filter(f=>f.endsWith('.png')&&f.startsWith('binchika-'));check(downloaded.length>0,'PNG downloaded');
  check((await page.$eval('#rd-top img',el=>el.complete&&el.naturalWidth>0).catch(()=>page.$eval('.rd-top img',el=>el.complete&&el.naturalWidth>0))),'transparent brand asset loads');
  await page.evaluate(()=>{navigator.share=async payload=>{window.__shared=payload;};});await page.click('#rd-share');check(await page.evaluate(()=>window.__shared.text.includes('Only INEC declares results.')&&window.__shared.text.includes('WAT')),'share payload has timestamp and disclaimer');
  for(const width of [390,320]){
    await page.setViewport({width,height:844,deviceScaleFactor:1,isMobile:true});
    await page.waitForFunction(()=>document.querySelector('#rd-sync')?.dataset.state==='fresh'&&document.querySelector('#rd-lineup button'),{timeout:20000});
    await page.$eval('.rd-section',el=>el.scrollIntoView({behavior:'instant',block:'start'}));
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`no page overflow at ${width}px`);
    check(await page.$eval('#rd-lineup button',el=>el.getBoundingClientRect().height>=44),`party controls meet touch target at ${width}px`);
    await (await page.$('#rd-panel')).screenshot({path:resolve(evidence,`mobile-${width}.png`)});
  }
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);check(await page.$eval('.rd-track span',el=>getComputedStyle(el).transitionDuration)==='0s','reduced motion disables bar transitions');
  check(errors.length===0,'no browser runtime errors');console.log('Measured initial CLS '+(await page.evaluate(()=>window.__cls)).toFixed(4));
  if(fixtures){mode='failure';await page.reload({waitUntil:'networkidle2'});await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='unavailable');check(await page.$eval('#rd-votes',el=>el.textContent)==='—','first-load failure never displays a zero tally');check(await page.$eval('#rd-snap',el=>el.disabled),'snapshot disabled without data');}
  console.log(`PASS ${checks} browser checks (${fixtures?'browser-only fixtures':'real feed'}). Evidence: ${evidence}`);
}finally{await browser.close();if(server)await new Promise(r=>server.close(r));}
