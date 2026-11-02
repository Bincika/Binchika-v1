// Presentation maths only. This module never infers seats or changes a tally.
import {leader, spread} from './results.js';

export function eligibleStates(race, states, rules) {
  return states.filter(s => race === 'governor' ? s.iso !== 'NG-FC' && !rules.governor.offCycle.includes(s.iso) : ['state-assembly','local-government'].includes(race) ? s.iso !== 'NG-FC' : true);
}

export function stateSummaries(data, states) {
  return states.map(s => {
    const value=data?.byState?.[s.iso],totals=value?.totals??{};
    return {...s,units:value?.units??0,totals,sum:Object.values(totals).reduce((a,b)=>a+b,0),largest:leader(totals)};
  });
}

export function reportedStateCounts(data, states) {
  const counts={},rows=stateSummaries(data,states);let ties=0,reported=0;
  for(const s of rows){if(s.iso==='NG-FC')continue;if(s.sum>0)reported++;if(s.largest?.tie)ties++;if(s.largest?.party)counts[s.largest.party]=(counts[s.largest.party]??0)+1;}
  return {counts,ties,reported,totalStates:states.filter(s=>s.iso!=='NG-FC').length,fct:rows.find(s=>s.iso==='NG-FC')?.largest??null};
}

export function reportedSpread(data,states,party) {
  const rows=stateSummaries(data,states),areas=Object.fromEntries(rows.filter(s=>s.iso!=='NG-FC').map(s=>[s.iso,s.totals]));
  const fct=rows.find(s=>s.iso==='NG-FC');
  return {states:spread(areas)[party]??0,fct:!!(fct?.sum&&((fct.totals[party]??0)/fct.sum)>=.25)};
}

export const DASHBOARD_RACES = {
  president: {label:'Presidential election',place:'Aso Rock Villa',phrase:'Every report. A clearer picture.',colour:'#123B78',icon:'president',picture:0},
  senate: {label:'Senate',place:'The Red Chamber',phrase:'The Red Chamber, in public.',colour:'#8E1939',icon:'senate'},
  house: {label:'House of Representatives',place:'The Green Chamber',phrase:"The people's chamber. The public's count.",colour:'#08704C',icon:'house'},
  governor: {label:'Governorship',place:'Governorship',phrase:'Every state. Every report.',colour:'#8B3510',icon:'president',picture:3},
  'state-assembly': {label:'State Houses of Assembly',place:'State Houses of Assembly',phrase:'State voices. An open count.',colour:'#765610',icon:'house',picture:4},
  'local-government': {label:'Local Government',place:'Local Government',phrase:'Community reports, in public.',colour:'#08616B',icon:'house',picture:5},
};

export function dashboardRows(parties, totals, {limit = 5, hideSmall = false, hidden = new Set()} = {}) {
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) throw new Error('Invalid tally');
  for (const [name, votes] of Object.entries(totals)) {
    if (!/^[A-Z0-9][A-Z0-9 -]{0,24}$/.test(name) || !Number.isSafeInteger(votes) || votes < 0) throw new Error('Invalid reported votes');
  }
  const registry = new Map(parties.map(p => [p.acronym, p]));
  const names = [...new Set([...registry.keys(), ...Object.keys(totals)])];
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum)) throw new Error('Invalid total');
  const all = names.map(acronym => ({acronym, name: registry.get(acronym)?.name ?? 'Registration not verified in the current party list', registered: registry.has(acronym), votes: totals[acronym] ?? 0, share: sum ? (totals[acronym] ?? 0) / sum : 0}));
  all.sort((a, b) => b.votes - a.votes);
  const eligible = all.filter(p => !hidden.has(p.acronym) && (!hideSmall || !sum || p.share >= .05));
  return {all, sum, eligible, visible: eligible.slice(0, limit)};
}

// Each dot represents one percentage point, never a seat. Largest remainders
// keep rounding exact; hiding a party cannot inflate the others' shares.
export function shareDots(parties) {
  if (!parties.some(p => p.share > 0)) return Array(100).fill(null);
  const allocation = parties.map((p, i) => ({p, i, count: Math.floor(p.share * 100), remainder: (p.share * 100) % 1}));
  let remaining = 100 - allocation.reduce((n, a) => n + a.count, 0);
  for (const a of [...allocation].sort((a,b) => b.remainder - a.remainder || a.i - b.i)) {
    if (remaining-- <= 0) break;
    a.count++;
  }
  return allocation.flatMap(a => Array(a.count).fill(a.p.acronym));
}
