// /tally/ presentation only. The API, ledger and consensus rules are unchanged.
import { TENANT } from "./lib/tenant.generated.js";   // country values (tenants/<id>/tenant.json; session 98)
import { dashboardRows, eligibleStates, stateSummaries, reportedStateCounts, reportedSpread, DASHBOARD_RACES as RACES } from './lib/race-dashboard.js?v=85';
import { civicIcon, seatChamber, civicPicture } from './lib/race-art.js?v=85';
import {resultsFeed} from './lib/results-feed.js?v=85';
import {spread, twoThirds} from './lib/results.js';

const $ = id => document.getElementById(id);
const nf = new Intl.NumberFormat('en-GB');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const DISCLAIMER = `This is a public ledger of citizen-reported tallies. Only ${TENANT.electoralBody.short} declares results.`;
const LOGO = '/assets/img/dashboard/binchika-transparent.png';
const CIVIC_ART = '/assets/img/dashboard/nigerian-civic-art.webp';
const demoParties = ['ALPHA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT'].map(acronym => ({acronym, name:`Fictional ${acronym}`}));
const demoColour = ['#1559D6','#C42B3C','#0F8A5F','#B26B00','#7A4FD0','#5E6B78'];
let races = {}, stateMeta = [], partyData = {parties:[],palette:[]}, registryAt = 0, colour = {};
const initialRace = new URLSearchParams(location.search).get('race');
let race = Object.hasOwn(RACES,initialRace) ? initialRace : 'president';
let data = null, syncState = 'loading', showAll = false, hideSmall = false, alphabetic = false;
let hidden = new Set(), rosterSignature = '', preparedSnapshot = null, measure='votes', selectedState=null, stateScopeSignature='', registryLoading=false;
const randomOrder = new Map();
function registry() {
  const parties = DEMO ? demoParties : partyData.parties;
  for (const p of parties) if (!randomOrder.has(p.acronym)) randomOrder.set(p.acronym, Math.random());
  return [...parties].sort((a,b) => randomOrder.get(a.acronym) - randomOrder.get(b.acronym));
}
function view() { return dashboardRows(registry(), data?.national?.totals ?? {}, {limit:showAll ? Infinity : 5, hideSmall, hidden}); }
function palette() {
  colour = Object.fromEntries(partyData.parties.map((p,i) => [p.acronym, /^#[0-9a-f]{6}$/i.test(partyData.palette[i]) ? partyData.palette[i] : '#64748b']));
  if (DEMO) demoParties.forEach((p,i) => {colour[p.acronym] = demoColour[i];});
  window.dispatchEvent(new CustomEvent('binchika:parties',{detail:partyData}));
}
const stamp = iso => new Date(iso).toLocaleString('en-GB', {timeZone:TENANT.locale.timeZone,day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}) + ` ${TENANT.locale.zoneLabel}`;
async function getJson(url, signal) {
  const response = await fetch(url, {signal,cache:'no-store'});
  if (!response.ok) throw new Error('Ledger connection failed');
  return response.json();
}
async function refresh() {
  const requested=race;
  if(!DEMO && Date.now()-registryAt>300000){
    try{const latest=await getJson('/data/parties.json');if(Array.isArray(latest.parties)&&Array.isArray(latest.palette)){partyData=latest;registryAt=Date.now();palette();}}catch{}
  }
  applyFeed(await resultsFeed.ensure(requested,{force:true}));
}
function applyFeed(state){if(state.race!==race)return;data=state.data;syncState=state.status;preparedSnapshot=null;$('rd-panel').dataset.resultsVersion=state.revision??'';if(Object.keys(races).length)draw();if(state.status==='fresh'&&!DEMO&&Date.now()-registryAt>300000&&!registryLoading){registryLoading=true;getJson('/data/parties.json').then(latest=>{if(Array.isArray(latest.parties)&&Array.isArray(latest.palette)){partyData=latest;registryAt=Date.now();palette();draw();}}).catch(()=>{}).finally(()=>{registryLoading=false;});}}
const scope = () => eligibleStates(race,stateMeta,races);
function updateSync() {
  const state = $('rd-sync'); state.dataset.state = syncState;
  state.textContent = syncState === 'not-connected' ? 'SIEC reporting feed not connected' : DEMO ? 'Demo: fictional parties and figures' : ({fresh:'Connected · refreshes every 30 seconds',loading:'Refreshing the public ledger…',stale:'Refresh failed · showing the last received figures',unavailable:'Ledger unavailable · use Refresh now to retry'})[syncState];
  $('rd-panel').setAttribute('aria-busy',String(syncState === 'loading'));
  $('rd-refresh').disabled = syncState === 'loading' || syncState === 'not-connected';
  $('rd-snap').disabled = !data;
  $('rd-share').disabled = !data;
}
function drawArtwork(v) {
  const r = RACES[race];
  $('rd-art-title').textContent = r.place;
  if (r.picture !== undefined) {
    $('rd-art').innerHTML = civicPicture(r.picture);
    $('rd-art-note').textContent = race === 'president' ? 'Aso Rock-inspired architectural illustration. Citizen reports, shown in public.' : race === 'local-government' ? 'Community illustration. Elections are run by SIECs; no reporting feed is connected yet.' : 'Nigerian civic illustration. Citizen-reported tallies; no seat allocations are inferred.';
  } else {
    const total=races[race].seats;
    $('rd-art').innerHTML = seatChamber(total);
    $('rd-art-note').textContent = `${total} structural seats. Grey means unassigned: no sourced constituency allocation feed is connected. State vote shares never allocate seats.`;
  }
}
function renderRoster(v) {
  const all = [...v.all].sort((a,b) => alphabetic ? a.acronym.localeCompare(b.acronym,'en-GB') : (randomOrder.get(a.acronym) ?? .5) - (randomOrder.get(b.acronym) ?? .5));
  const signature = all.map(p => p.acronym).join('|');
  if (signature !== rosterSignature) {
    $('rd-lineup').innerHTML = all.map(p => `<button type="button" class="rd-party" data-party="${esc(p.acronym)}" style="--party:${colour[p.acronym] ?? '#64748b'}"><b>${esc(p.acronym)}</b><span></span></button>`).join('');
    rosterSignature = signature;
  }
  for (const button of $('rd-lineup').querySelectorAll('[data-party]')) {
    const p = v.all.find(p => p.acronym === button.dataset.party);
    button.setAttribute('aria-pressed',String(!hidden.has(p.acronym)));
    button.setAttribute('aria-label',`${p.acronym}, ${p.name}, ${data ? (p.share*100).toFixed(1)+'% of reported votes' : 'data unavailable'}. ${hidden.has(p.acronym) ? 'Show' : 'Hide'} party.`);
    button.style.setProperty('--share', `${Math.max(0,Math.min(100,p.share*100))}%`);
    button.querySelector('span').textContent = hidden.has(p.acronym) ? 'Hidden' : data ? `${(p.share*100).toFixed(1)}%` : '—';
  }
  $('rd-order').setAttribute('aria-pressed',String(alphabetic));
  $('rd-order').textContent = alphabetic ? 'Use visit order' : 'Order A–Z';
  $('rd-table').querySelector('tbody').innerHTML = v.all.map(p => `<tr><th scope="row">${esc(p.acronym)}</th><td>${esc(p.name)}${p.registered ? '' : ' (unverified)'}</td><td class="num">${data ? nf.format(p.votes) : '—'}</td><td class="num">${data ? (p.share*100).toFixed(1)+'%' : '—'}</td></tr>`).join('');
}
function draw() {
  const r = RACES[race], rc = races[race], v = view(), card = $('rd-panel');
  const areas=reportedStateCounts(data,scope());
  const nationalReference = ['president','senate','house'].includes(race);
  card.className = `rd-card rd-${race}`; card.style.setProperty('--rd-a',r.colour);
  card.setAttribute('aria-labelledby',`rd-tab-${race}`);
  $('rd-race').textContent = `${r.label} · ${rc?.date ? new Date(rc.date+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : race === 'local-government' ? 'Dates set by each state' : 'Nigeria 2027'}`;
  $('rd-phrase').textContent = r.phrase; $('rd-icon').innerHTML = civicIcon(r.icon);
  $('rd-units').textContent = data ? nf.format(data.units.reported) : '—';
  $('rd-units-of').textContent = data ? nationalReference ? `of ${nf.format(data.units.total)} polling units have high-agreement citizen reports` : 'polling units have high-agreement citizen reports; the race-wide total is not supplied' : 'polling-unit coverage unavailable';
  $('rd-votes').textContent = data ? nf.format(v.sum) : '—';
  const coverage = data && nationalReference ? data.units.reported/data.units.total : 0;
  $('rd-coverage').textContent = data && nationalReference ? `${(coverage*100).toFixed(2)}%` : '—';
  $('rd-coverage-label').textContent = nationalReference ? 'of polling units reporting' : race === 'local-government' ? 'reporting feed not connected' : 'race-wide polling-unit total not supplied';
  $('rd-meter-fill').style.width = `${coverage*100}%`;
  $('rd-time').textContent = data ? `Data received ${stamp(data.updatedAt)}${syncState === 'stale' ? ' · refresh failed' : ''}` : race === 'local-government' ? 'No local government tally feed connected' : 'No successful ledger refresh yet';
  if (data) $('rd-time').dateTime = data.updatedAt; else $('rd-time').removeAttribute('datetime');
  $('rd-bars').setAttribute('aria-label',measure==='votes'?'Reported votes by party':'States with a unique largest reported share by party');
  $('rd-bars').innerHTML = v.visible.map(p => {
    const count=areas.counts[p.acronym]??0,share=measure==='states'?(areas.totalStates?count/areas.totalStates:0):p.share,value=measure==='states'?`${count} ${count===1?'state':'states'}`:(100*p.share).toFixed(1)+'%';
    return `<li><i class="rd-sw" style="background:${colour[p.acronym] ?? '#64748b'}"></i><b>${esc(p.acronym)}</b><span class="rd-track" role="img" aria-label="${esc(p.acronym)}: ${data ? esc(value) : 'unavailable'}"><span style="width:${100*share}%;background:${colour[p.acronym] ?? '#64748b'}"></span></span><span class="rd-val">${data ? value : '—'}<small>${data ? nf.format(p.votes)+' votes' : 'Unavailable'}</small></span></li>`;
  }).join('');
  $('rd-more').textContent = showAll ? 'Show five bars' : `Show all ${v.eligible.length} parties`;
  $('rd-more').setAttribute('aria-expanded',String(showAll));
  $('rd-more').disabled = !showAll && v.eligible.length <= 5;
  const omitted = v.all.length-v.visible.length;
  $('rd-note').textContent = race === 'local-government' ? 'No local government tallies are shown. A reporting feed must be connected for the relevant SIEC. The national party registry remains below for reference.' : !data ? 'The ledger could not be reached. Use Refresh now to retry. No figures are assumed.' : !v.sum ? `No high-agreement reports yet. Bars fill as polling units are written to the ledger. ${v.all.length} parties remain in the full line-up below; five bars are shown by default.` : !v.visible.length ? 'All parties are hidden by your filters. Use Show every party to restore the view.' : `${v.visible.length} of ${v.all.length} parties shown${omitted ? `; ${omitted} remain in the full list` : ''}. Shares always use all ${nf.format(v.sum)} reported votes.`;
  if(measure==='states' && data)$('rd-note').textContent=`${areas.reported} of ${areas.totalStates} states have reported votes; ${areas.ties} tied. A state counts only with a unique largest reported share. ${areas.fct?.party?`FCT: ${areas.fct.party}, shown separately.`:'FCT is separate where applicable.'} State counts do not imply constituency wins.`;
  $('rd-hide').disabled = !data || !v.sum; $('rd-hide').checked = hideSmall;
  $('rd-wm').hidden = !DEMO;
  card.querySelector('.rd-disc').textContent = race === 'local-government' ? 'This is a public ledger of citizen-reported tallies. SIECs run local government elections; Binchika never declares a result.' : DISCLAIMER;
  for (const b of document.querySelectorAll('[data-rd]')) {
    const selected = b.dataset.rd === race;
    b.setAttribute('aria-selected',String(selected)); b.setAttribute('aria-pressed',String(selected)); b.tabIndex = selected ? 0 : -1;
  }
  drawScope(); drawArtwork(v); renderRoster(v); drawRules(); drawStates(); updateSync();
}
function drawScope() {
  const message = $('rd-selection'), rc = races[race];
  message.hidden = race !== 'local-government' && rc?.verified !== false;
  message.textContent = race === 'local-government' ? 'Local Government elections are run by State Independent Electoral Commissions (SIECs), on dates each state sets. No local government reporting feed is connected yet.' : rc?.verified === false ? `Verification note: ${rc.offCycleNote ?? rc.rule}` : '';
}
function drawRules(){
  const rc=races[race];$('rd-rule-text').textContent=rc.rule;
  $('rd-rule-source').href=rc.ruleSource??'https://justice.gov.ng/wp-content/uploads/2020/09/Nigerian-Constitution.pdf';
  const notes={president:'24 of 36 states is a two-thirds arithmetic reference. FCT reporting is shown separately. Partial citizen reports do not establish legal qualification; INEC applies the Constitution.',senate:'109 seats; 55 is a majority of the full chamber. Each constituency is decided separately, without the presidential 25% spread test. Seat allocations are not connected.',house:'360 seats; 181 is a majority of the full chamber. Each constituency is decided separately, without the presidential 25% spread test. Seat allocations are not connected.',governor:'28 scheduled governorship contests. The state selector excludes the eight off-cycle states and the FCT. LGA spread uses the votes reported so far and never certifies a result.','state-assembly':'All 36 states elect Assemblies, including off-cycle governorship states. The FCT does not. 993 is the 2023 seat reference; the current total is not yet verified.','local-government':'SIEC calendars are separate. There is no national 28-state list. Chairman and councillor rules differ; no local reporting feed is connected.'};
  $('rd-rule-note').textContent=notes[race];
}
function drawStates(){
  const areas=scope().sort((a,b)=>a.name.localeCompare(b.name,'en-GB')),signature=race+areas.map(s=>s.iso).join('|');
  if(selectedState&&!areas.some(s=>s.iso===selectedState))selectedState=null;
  if(signature!==stateScopeSignature){$('rd-state').innerHTML='<option value="">Choose an area…</option>'+areas.map(s=>`<option value="${s.iso}">${esc(s.name)}</option>`).join('');stateScopeSignature=signature;}
  $('rd-state').value=selectedState??'';
  $('rd-state-scope').textContent=race==='governor'?'28 governorship states. Off-cycle states and FCT are excluded.':race==='state-assembly'?'All 36 states, including states whose governors are elected off-cycle.':race==='local-government'?'36 state jurisdictions; local dates and offices depend on each SIEC. No local feed is connected.':'36 states and the FCT. FCT is shown separately from state counts.';
  const all=stateSummaries(data,areas),current=all.find(s=>s.iso===selectedState);
  $('rd-states-table').querySelector('tbody').innerHTML=all.map(s=>`<tr><th scope="row"><button type="button" class="rd-area-button" data-area="${s.iso}">${esc(s.name)}</button></th><td>${!data?'Unavailable':s.largest?.tie?'Tied reported votes':s.largest?.party?esc(s.largest.party)+' · '+(s.largest.share*100).toFixed(1)+'%':'No reported votes'}</td><td class="num">${data&&s.largest?nf.format(s.largest.votes):'—'}</td><td class="num">${data?nf.format(s.units):'—'}</td></tr>`).join('');
  $('rd-state-table').querySelector('caption').textContent=current?`Citizen-reported votes: ${current.name}`:'Reported party votes in the selected area';
  $('rd-state-status').textContent=!current?'Choose an area to see its reported party totals and reporting references.':!data?`${current.name}: reporting data unavailable.`:!current.units?`${current.name}: no citizen reports yet. Party vote counts are unavailable.`:`${current.name}: ${current.largest?.tie?'tied highest reported votes':current.largest?.party?current.largest.party+' has the largest reported share':'no reported votes'}. ${nf.format(current.units)} polling units. Data received ${stamp(data.updatedAt)}. These are partial citizen reports.`;
  if(!current){$('rd-state-table').querySelector('tbody').innerHTML='';return;}
  const rows=dashboardRows(registry(),current.totals,{limit:Infinity}).all;
  const lgas=data?.byLga?.[current.iso],lgaSpread=lgas?spread(Object.fromEntries(Object.entries(lgas).map(([k,v])=>[k,v.totals]))):null;
  $('rd-state-table').querySelector('tbody').innerHTML=rows.map(p=>{
    let reference='Separate constituency tallies are needed; a state aggregate never assigns seats.';
    if(race==='president'){const ref=reportedSpread(data,scope(),p.acronym);reference=`At least 25% of reported votes in ${ref.states} states; FCT ${ref.fct?'at or above 25%':'below 25% or unreported'}.` ;}
    if(race==='governor')reference=lgaSpread?`${lgaSpread[p.acronym]??0} reporting LGA codes at or above 25%; ${twoThirds(current.lgas)} of ${current.lgas} is the two-thirds reference. No legal qualification is inferred.`:'LGA reporting breakdown not supplied yet.';
    if(race==='local-government')reference='A separately sourced SIEC event and reporting feed are needed.';
    return `<tr><th scope="row">${esc(p.acronym)}</th><td class="num">${data&&current.units>0?nf.format(p.votes):'—'}</td><td class="num">${data&&current.units>0?(p.share*100).toFixed(1)+'%':'—'}</td><td>${esc(reference)}</td></tr>`;
  }).join('');
}
function selectState(iso,notify=false){selectedState=scope().some(s=>s.iso===iso)?iso:null;drawStates();if(selectedState)$('rd-state-details').open=true;if(notify)window.dispatchEvent(new CustomEvent('binchika:dashboard-state',{detail:selectedState}));}
async function selectRace(key, notify = false) {
  if (!Object.hasOwn(RACES,key)) return;
  const changed = key !== race;
  if (changed) {
    race = key; const state=resultsFeed.read(key);data=state.data;syncState=state.status; hidden = new Set(); preparedSnapshot = null;
    $('rd-panel').dataset.resultsVersion=state.revision??'';draw();
  }
  // Notify at the moment of the click. A slow response must never replay an
  // older tab selection over a newer state/local race-card selection.
  if (notify) { drawScope(); window.dispatchEvent(new CustomEvent('binchika:dashboard-race',{detail:key})); }
  if (changed) applyFeed(await resultsFeed.watch(key));
}
function followRace(key) {
  selectRace(key);
}

// Freeze the view before awaiting assets: a refresh cannot mix races in one PNG.
const loadImage = src => new Promise((resolve,reject) => {const img = new Image(); img.onload=()=>resolve(img); img.onerror=reject; img.src=src;});
async function makeSnapshot() {
  const k = race, r = RACES[k], v = view(), captured = structuredClone(data), stale = syncState !== 'fresh';
  const capturedColours = {...colour},capturedMeasure=measure,capturedStates=reportedStateCounts(captured,scope());
  const capturedRoster=[...v.all].sort((a,b)=>alphabetic ? a.acronym.localeCompare(b.acronym) : (randomOrder.get(a.acronym)??.5)-(randomOrder.get(b.acronym)??.5));
  if (!captured) throw new Error('No data');
  const savedAt = new Date().toISOString(), W=1440, H=1080;
  const c=document.createElement('canvas'); c.width=W; c.height=H; const g=c.getContext('2d');
  await document.fonts.ready;
  const font='"Atkinson Hyperlegible", sans-serif';
  g.fillStyle=r.colour; g.fillRect(0,0,W,H);
  g.fillStyle='#fff'; g.font=`800 38px ${font}`; g.fillText('Binchika · '+r.label,126,62);
  g.font=`700 29px ${font}`; g.fillText(r.phrase,126,108);
  try {g.drawImage(await loadImage(LOGO),28,20,82,82);} catch {}
  g.fillStyle='#f8fbff'; g.fillRect(24,138,W-48,806);
  g.fillStyle='#152842'; g.font=`800 38px ${font}`; g.fillText(nf.format(captured.units.reported)+' polling units',50,200);
  g.font=`400 23px ${font}`; g.fillText(['president','senate','house'].includes(k) ? `of ${nf.format(captured.units.total)} · ${nf.format(v.sum)} reported votes · ${(captured.units.reported/captured.units.total*100).toFixed(2)}% coverage` : `${nf.format(v.sum)} reported votes · race-wide polling-unit total not supplied`,50,240);
  g.fillText(`Data received ${stamp(captured.updatedAt)}${stale ? ' · last received figures, refresh not current' : ''}`,50,276);
  if(r.picture !== undefined) {
    try {const img=await loadImage(CIVIC_ART);const cell=img.naturalWidth/3, cropHeight=cell*310/466;g.drawImage(img,(r.picture%3)*cell,Math.floor(r.picture/3)*cell+(cell-cropHeight)/2,cell,cropHeight,900,310,466,310);} catch {}
  } else {
    const art=seatChamber(races[k].seats);
    try {g.drawImage(await loadImage('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(art)),900,320,466,254);} catch {}
  }
  g.fillStyle='#152842';g.font=`800 26px ${font}`;g.fillText(r.place,920,654,440);
  g.font=`400 18px ${font}`;g.fillText(r.picture !== undefined ? 'Decorative civic illustration' : `${races[k].seats} seats · all unassigned`,920,688);
  v.visible.slice(0,8).forEach((p,i)=>{
    const y=325+i*43;g.fillStyle='#dfe7f1';g.fillRect(170,y,450,23);
    const count=capturedStates.counts[p.acronym]??0,barShare=capturedMeasure==='states'?(capturedStates.totalStates?count/capturedStates.totalStates:0):p.share;
    g.fillStyle=capturedColours[p.acronym]??'#64748b';g.fillRect(170,y,450*barShare,23);
    g.fillStyle='#152842';g.font=`700 22px ${font}`;g.fillText(p.acronym,50,y+20);
    g.font=`600 20px ${font}`;g.fillText(`${capturedMeasure==='states'?count+' states':(p.share*100).toFixed(1)+'%'} · ${nf.format(p.votes)}`,642,y+20);
  });
  g.fillStyle='#40516b';g.font=`400 18px ${font}`;g.fillText(capturedMeasure==='states'?'Reported states by party · unique largest reported share; FCT separate.':!v.sum?'No high-agreement reports yet.':`${v.visible.length} parties selected. Percentages use every reported vote.`,50,704);
  if(v.visible.length>8)g.fillText(`${v.visible.length-8} additional selected bars in the full list below.`,50,732);
  g.font=`700 20px ${font}`;g.fillStyle='#152842';g.fillText('Full party line-up · all reported shares',50,775);
  const all=capturedRoster;
  const columns=Math.max(11,Math.ceil(all.length/2)), cell=(W-100)/columns;
  all.forEach((p,i)=>{const x=50+(i%columns)*cell,y=800+Math.floor(i/columns)*59;g.fillStyle=capturedColours[p.acronym]??'#64748b';g.fillRect(x,y,cell-10,4);g.fillStyle='#152842';g.font=`700 ${all.length>26?14:17}px ${font}`;g.fillText(p.acronym,x,y+25,cell-12);g.font=`400 16px ${font}`;g.fillText((p.share*100).toFixed(1)+'%',x,y+47,cell-12);});
  g.fillStyle='#fff';g.font=`700 24px ${font}`;g.fillText(DISCLAIMER,40,984);
  g.font=`400 20px ${font}`;g.fillText(`Saved ${stamp(savedAt)} · binchika.com/tally/`,40,1026);
  if(DEMO){g.save();g.translate(W/2,H/2);g.rotate(-.25);g.fillStyle='#102b4c33';g.textAlign='center';g.font=`900 160px ${font}`;g.fillText('DEMO',0,0);g.restore();}
  const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));if(!blob)throw new Error('PNG unavailable');
  return {blob,name:`binchika-${k}-${savedAt.slice(0,19).replace(/[:T]/g,'-')}${DEMO?'-demo':''}.png`,text:`${DEMO?'DEMO · fictional parties and figures. ':''}Binchika · ${r.label}. ${nf.format(v.sum)} citizen-reported votes. Data received ${stamp(captured.updatedAt)}. Saved ${stamp(savedAt)}.${stale?' Refresh not current; last received figures.':''} ${DISCLAIMER}`,race:k};
}
async function saveSnapshot() {
  $('rd-status').textContent='Preparing your branded snapshot…';$('rd-snap').disabled=true;
  try {const snap=await makeSnapshot(); preparedSnapshot=snap;const url=URL.createObjectURL(snap.blob),a=Object.assign(document.createElement('a'),{href:url,download:snap.name});a.click();setTimeout(()=>URL.revokeObjectURL(url),4000);$('rd-status').textContent=`Snapshot saved as ${snap.name}. It includes both timestamps and the INEC disclaimer.`;} catch {$('rd-status').textContent='This browser could not save the image. Try another browser.';} finally {$('rd-snap').disabled=!data;}
}
async function share() {
  if(!data)return;
  const text=preparedSnapshot?.race===race ? preparedSnapshot.text : `${DEMO?'DEMO · fictional parties and figures. ':''}Binchika · ${RACES[race].label}. Data received ${stamp(data.updatedAt)}. Shared ${stamp(new Date().toISOString())}.${syncState!=='fresh'?' Refresh not current; last received figures.':''} ${DISCLAIMER}`;
  const url=`${location.origin}/tally/?race=${race}${DEMO?'&demo=1':''}`;
  try {
    if(navigator.share){
      const file=preparedSnapshot?.race===race ? new File([preparedSnapshot.blob],preparedSnapshot.name,{type:'image/png'}) : null;
      if(file && navigator.canShare?.({files:[file]}))await navigator.share({files:[file],title:`Binchika · ${RACES[race].label}`,text});
      else await navigator.share({title:`Binchika · ${RACES[race].label}`,text,url});
      $('rd-status').textContent='Share completed.';
    } else {await navigator.clipboard.writeText(text+' '+url);$('rd-status').textContent='Timestamped text and link copied. Paste into your preferred social app. Save snapshot first to attach the image.';}
  } catch(e){$('rd-status').textContent=e.name==='AbortError'?'Sharing cancelled.':'Sharing is unavailable here. Save the snapshot to post it in your preferred app.';}
}
for(const b of document.querySelectorAll('[data-rd]')) {
  b.addEventListener('click',()=>selectRace(b.dataset.rd,true));
  b.addEventListener('keydown',e=>{if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...document.querySelectorAll('[data-rd]')],i=tabs.indexOf(b);const next=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();selectRace(tabs[next].dataset.rd,true);});
}
$('rd-hide').addEventListener('change',e=>{hideSmall=e.target.checked;preparedSnapshot=null;draw();});
$('rd-more').addEventListener('click',()=>{showAll=!showAll;preparedSnapshot=null;draw();});
$('rd-order').addEventListener('click',()=>{alphabetic=!alphabetic;rosterSignature='';draw();});
$('rd-reset').addEventListener('click',()=>{hidden.clear();hideSmall=false;showAll=false;preparedSnapshot=null;draw();});
$('rd-lineup').addEventListener('click',e=>{const p=e.target.closest('[data-party]')?.dataset.party;if(!p)return;hidden.has(p)?hidden.delete(p):hidden.add(p);preparedSnapshot=null;draw();});
$('rd-refresh').addEventListener('click',refresh);
$('rd-measure').addEventListener('change',e=>{measure=e.target.value;preparedSnapshot=null;draw();});
$('rd-state').addEventListener('change',e=>selectState(e.target.value,true));
$('rd-states-table').addEventListener('click',e=>{const iso=e.target.closest('[data-area]')?.dataset.area;if(iso)selectState(iso,true);});
$('rd-snap').addEventListener('click',saveSnapshot);
$('rd-share').addEventListener('click',share);
window.addEventListener('binchika:race',e=>followRace(e.detail));
window.addEventListener('binchika:state',e=>selectState(e.detail));
window.addEventListener('binchika:request-parties',()=>{if(partyData.parties.length)palette();});
resultsFeed.subscribe(applyFeed);
try {
  const [raceData,parties,states]=await Promise.all([getJson('/data/races.json'),getJson('/data/parties.json'),getJson('/data/states.json')]);
  races=raceData.races;stateMeta=states.states.map((s,i)=>({...s,name:DEMO?`Demo area ${i+1}`:s.name}));partyData=parties;registryAt=Date.now();palette();draw();
  followRace(new URLSearchParams(location.search).get('race')??'president');
  applyFeed(await resultsFeed.watch(race));
} catch {syncState='unavailable';updateSync();$('rd-note').textContent='The party list could not be loaded. Reload this page to retry.';}
