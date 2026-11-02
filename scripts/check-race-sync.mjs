// Real Chrome integration checks; synthetic responses remain in this browser only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import puppeteer from 'puppeteer-core';
const target=process.argv[2]??'local';let server,base=target,version=0,mode='normal';
const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.webp':'image/webp','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
if(target==='local'){server=createServer(async(req,res)=>{try{let path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path.endsWith('/'))path+='index.html';const file=resolve('site','.'+path);if(!file.startsWith(resolve('site')+'\\')&&!file.startsWith(resolve('site')+'/'))throw Error();res.writeHead(200,{'content-type':types[extname(file)]??'application/octet-stream'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;}
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('PASS '+label);};
const requests=[],errors=[];
const downloads=resolve('output/tally-dashboard-session85/sync');await mkdir(downloads,{recursive:true});
function fixture(race){
  const data={race,units:{reported:0,total:176846},national:{totals:{}},byState:{},byLga:{},updatedAt:`2026-10-30T20:00:${String(version).padStart(2,'0')}Z`};
  for(const[iso,code,totals]of[['NG-LA','24-01',version?{A:20,AA:80}:{A:75,AA:25}],['NG-KN','19-01',{A:40,AA:60}],['NG-AN','04-01',{A:50,AA:50}],['NG-FC','37-01',{A:10,AA:90}]]){
    if(mode==='fct-only'&&iso!=='NG-FC')continue;
    if(race==='governor'&&['NG-AN','NG-FC'].includes(iso)||race==='state-assembly'&&iso==='NG-FC')continue;
    data.byState[iso]={units:1,totals};data.byLga[iso]={[code]:{units:1,totals}};data.units.reported++;
    for(const[p,n]of Object.entries(totals))data.national.totals[p]=(data.national.totals[p]??0)+n;
  }
  if(mode==='invalid')data.national.totals.A++;
  return data;
}
try{
  const page=await browser.newPage();await page.setViewport({width:1440,height:1100});
  const session=await page.createCDPSession();await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  page.on('pageerror',e=>errors.push(e.message));
  await page.evaluateOnNewDocument(()=>{let library;Object.defineProperty(window,'maplibregl',{configurable:true,get:()=>library,set:value=>{library=value;const Original=value.Map;value.Map=new Proxy(Original,{construct(target,args,newTarget){const map=Reflect.construct(target,args,newTarget);window.__testMap=map;return map;}});}});window.__snapshotText=[];const fill=CanvasRenderingContext2D.prototype.fillText;CanvasRenderingContext2D.prototype.fillText=function(text,...rest){window.__snapshotText.push(text);return fill.call(this,text,...rest);};});
  await page.setRequestInterception(true);page.on('request',async req=>{if(req.isInterceptResolutionHandled())return;const url=new URL(req.url());if(url.pathname==='/api/results'){
    const race=url.searchParams.get('race');requests.push(race);if(mode==='slow'&&race==='house')await new Promise(r=>setTimeout(r,1400));
    return req.respond({status:mode==='failure'?503:200,contentType:'application/json',body:JSON.stringify(fixture(race))});
  }if(target==='local'&&url.pathname==='/api/config')return req.respond({status:200,contentType:'application/json',body:'{}'});req.continue();});
  await page.goto(base+'/tally/',{waitUntil:'networkidle2',timeout:60000});
  const matching=()=>page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh'&&document.querySelector('#rd-panel').dataset.resultsVersion&&document.querySelector('#rd-panel').dataset.resultsVersion===document.querySelector('#mon-map').dataset.resultsVersion);
  await matching();await page.waitForFunction(()=>window.__testMap?.getLayer('fill'));
  check(requests.filter(r=>r==='president').length===1,'dashboard and map share one initial result request');
  const palette=JSON.parse(await readFile('site/data/parties.json','utf8')),expected=palette.palette[palette.parties.findIndex(p=>p.acronym==='A')];
  check(await page.evaluate(()=>{const p=window.__testMap.getPaintProperty('fill','fill-color'),i=p.indexOf('NG-LA');return p[i+1];})===expected,'actual Lagos map paint matches party palette');
  check(await page.evaluate(()=>{const p=window.__testMap.getPaintProperty('fill','fill-color');return !p.includes('NG-AN');}),'tied state has no false party fill');
  await page.select('#rd-measure','states');
  check(await page.$eval('#rd-bars',el=>el.textContent.includes('1 state')),'state view counts unique reported pluralities');
  check(await page.$eval('#rd-note',el=>el.textContent.includes('1 tied')&&el.textContent.includes('FCT: AA')),'ties and FCT are explicitly separate');
  await page.click('#rd-state-details > summary');await page.select('#rd-state','NG-LA');
  check(await page.$eval('#mon-state-pick',el=>el.value)==='NG-LA','dashboard state selector synchronises the map selector');
  check(await page.$eval('#rd-state-status',el=>el.textContent.includes('A has the largest')),'selected state shows its largest reported share');
  await page.select('#mon-state-pick','NG-KN');check(await page.$eval('#rd-state',el=>el.value)==='NG-KN','map state selector synchronises dashboard details');
  check(requests.length===1,'measure and state selection do not fetch independent snapshots');
  const old=await page.$eval('#rd-panel',el=>el.dataset.resultsVersion);version=1;await page.click('#rd-refresh');await matching();
  check(requests.length===2,'manual refresh makes exactly one shared request');
  check(await page.$eval('#rd-panel',el=>el.dataset.resultsVersion)!==old,'accepted refresh has a new shared revision');
  check(await page.$eval('#rd-bars',el=>el.textContent.includes('2 states')),'state counts update from the same refreshed snapshot');
  const latest=await page.$eval('#rd-panel',el=>el.dataset.resultsVersion);mode='failure';await page.click('#rd-refresh');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='stale');
  check(await page.evaluate(()=>document.querySelector('#rd-panel').dataset.resultsVersion===document.querySelector('#mon-map').dataset.resultsVersion&&document.querySelector('#rd-panel').dataset.resultsVersion)!==false,'stale dashboard and map retain the same revision');
  check(await page.$eval('#rd-panel',el=>el.dataset.resultsVersion)===latest,'failed refresh does not replace last-good figures');
  mode='invalid';await page.click('#rd-refresh');await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='stale');check(await page.$eval('#rd-panel',el=>el.dataset.resultsVersion)===latest,'inconsistent national/state totals are rejected');mode='normal';
  await page.click('#rd-tab-governor');await matching();
  check(await page.$$eval('#rd-state option',o=>o.length-1)===28,'governorship dashboard has28 eligible states');
  check(await page.$$eval('#mon-state-pick option',o=>o.length-1)===28,'governorship map selector has the same28 states');
  check(await page.$('#rd-state option[value="NG-AN"]')===null,'off-cycle governor states cannot be selected');
  await page.select('#rd-state','NG-LA');check(await page.$eval('#rd-state-table',el=>el.textContent.includes('LGA codes')),'governor state details expose numeric LGA spread references');
  await page.click('#rd-tab-state-assembly');await matching();check(await page.$$eval('#rd-state option',o=>o.length-1)===36,'Assembly selector retains all36 states');check(await page.$('#rd-state option[value="NG-AN"]')!==null,'Anambra remains eligible for Assembly');
  await page.click('#rd-tab-senate');await matching();check(await page.$$eval('#rd-art circle',c=>c.length)===109,'Senate has109 structural seats');check(await page.$$eval('#rd-art circle',c=>new Set(c.map(e=>e.getAttribute('fill'))).size)===1,'vote shares do not colour assigned seats');
  mode='slow';await page.click('#rd-tab-house');await page.click('#rd-tab-local-government');await new Promise(r=>setTimeout(r,1700));
  check(await page.$eval('#rd-panel',el=>el.classList.contains('rd-local-government')),'delayed House data cannot overwrite Local Government');check(!requests.includes('local-government'),'no unsupported local results request');mode='normal';
  await page.click('#rd-tab-house');await matching();check(await page.$$eval('#rd-art circle',c=>c.length)===360,'House has360 structural seats');
  await page.click('#rd-snap');await page.waitForFunction(()=>document.querySelector('#rd-status').textContent.startsWith('Snapshot saved'));
  check(await page.evaluate(()=>window.__snapshotText.some(t=>String(t).includes('Reported states by party'))),'snapshot exports the selected state-count measure');
  await page.click('#rd-tab-governor');await matching();
  check(await page.$$eval('#mon-table tbody tr',rows=>rows.length)===28,'governor fallback table uses the same28 eligible states');
  if(!await page.$eval('#rd-state-details',e=>e.open))await page.click('#rd-state-details > summary');
  await page.select('#rd-state','NG-KE');check(await page.$eval('#rd-state-table tbody td',e=>e.textContent)==='—','unreported state party votes are unavailable, never assumed zero');
  await page.click('#rd-tab-state-assembly');await matching();
  check(await page.$$eval('#mon-table tbody tr',rows=>rows.length)===36,'Assembly fallback excludes the ineligible FCT');
  check(await page.$eval('#tally',e=>e.textContent.includes('2023 seat reference')&&e.textContent.includes('unverified')&&!e.textContent.includes('0 seats declared')),'lower Assembly tally distinguishes historical capacity and absent allocations');
  mode='fct-only';version++;await page.click('#rd-tab-president');await matching();await page.click('#rd-refresh');await matching();
  check(await page.$eval('#tally .tally-notes',e=>e.textContent.includes('25% in 0 states')),'FCT-only reports never become one state in the lower tally');
  for(const width of[390,320]){await page.setViewport({width,height:844});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`new controls fit${width}px`);}
  check(errors.length===0,'no browser runtime errors');console.log(`PASS ${checks} map/dashboard integration checks`);
}finally{await browser.close();if(server)await new Promise(r=>server.close(r));}
