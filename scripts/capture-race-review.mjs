// Capture and verify real dashboard views; no result data is supplied or changed.
// Usage: node scripts/capture-race-review.mjs https://binchika.com [output-folder]
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {DASHBOARD_RACES} from '../site/assets/js/lib/race-dashboard.js';

const base=(process.argv[2]??'https://binchika.com').replace(/\/$/,'');
const destination=resolve(process.argv[3]??'output/tally-dashboard-session85/live');
await mkdir(destination,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let checks=0;
const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('PASS '+label);};
try {
  for(const [device,viewport] of [['desktop',{width:1440,height:1100,deviceScaleFactor:1}],['mobile',{width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true}]]) {
    const page=await browser.newPage(),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/results')requests.push(new URL(request.url()).searchParams.get('race'));});
    await page.setViewport(viewport);
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.goto(base+'/tally/?race=president',{waitUntil:'networkidle2',timeout:60000});
    await page.waitForFunction(()=>document.querySelector('#rd-sync')?.dataset.state==='fresh',{timeout:20000});
    await page.evaluate(async()=>{await document.fonts.ready;const img=new Image();img.src='/assets/img/dashboard/nigerian-civic-art.webp';await img.decode();});
    check(await page.$$eval('[data-rd]',tabs=>tabs.length)===6,device+': six accessible dashboard tabs');
    for(const [key,race] of Object.entries(DASHBOARD_RACES)) {
      await page.click(`#rd-tab-${key}`);
      await page.waitForFunction(key=>document.querySelector('#rd-panel').classList.contains('rd-'+key)&&document.querySelector('#rd-sync').dataset.state===(key==='local-government'?'not-connected':'fresh'),{timeout:20000},key);
      check(await page.$eval('#race-pick',el=>el.value)===key,`${device}: ${key} picker and tab match`);
      check(await page.$eval(`[data-race="${key}"]`,el=>el.getAttribute('aria-pressed'))==='true',`${device}: ${key} race card matches`);
      if(race.picture!==undefined){
        const expected=`${(race.picture%3)*512} ${Math.floor(race.picture/3)*512} 512 512`;
        check(await page.$eval('#rd-art svg',el=>el.getAttribute('viewBox'))===expected,`${device}: ${key} uses its approved picture`);
      } else check(await page.$$eval('#rd-art circle',dots=>dots.length)===(key==='senate'?109:360),`${device}: ${key} exact structural seat count`);
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${device}: ${key} has no horizontal overflow`);
      check(await page.$eval('#rd-wm',el=>el.hidden),`${device}: ${key} is the real feed, no demo`);
      if(key==='local-government'){
        check(!requests.includes(key),device+': no unsupported local result request');
        check(await page.$eval('#rd-votes',el=>el.textContent)==='—',device+': no assumed local government votes');
        check(await page.$eval('#rd-art-note',el=>el.textContent.includes('SIECs')),device+': local image caption names SIECs');
      }
      if(['governor','state-assembly'].includes(key))check(await page.$eval('#rd-coverage',el=>el.textContent)==='—',`${device}: ${key} does not assume a race-wide denominator`);
      await page.$eval('#rd-panel',el=>el.scrollIntoView({behavior:'instant',block:'start'}));
      await (await page.$('#rd-panel')).screenshot({path:resolve(destination,`${device}-${key}.png`)});
    }
    await page.focus('#rd-tab-local-government');await page.keyboard.press('Home');
    await page.waitForFunction(()=>document.querySelector('#rd-sync').dataset.state==='fresh');
    check(await page.$eval('#rd-tab-president',el=>el.getAttribute('aria-selected'))==='true',device+': Home selects President');
    await page.keyboard.press('End');
    check(await page.$eval('#rd-tab-local-government',el=>el.getAttribute('aria-selected'))==='true',device+': End selects Local Government');
    check(errors.length===0,device+': no browser runtime errors');
    await page.close();
  }
  console.log(`PASS ${checks} review checks; 12 screenshots from ${base}; saved to ${destination}`);
} finally {await browser.close();}
