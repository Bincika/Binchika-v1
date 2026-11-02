// Original raised civic emblems, with a different silhouette for each race.
export function civicPicture(cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell > 5) throw new Error('Unknown civic picture');
  return `<svg class="rd-villa" viewBox="${(cell % 3) * 512} ${Math.floor(cell / 3) * 512} 512 512" preserveAspectRatio="xMidYMid slice"><image href="/assets/img/dashboard/nigerian-civic-art.webp" width="1536" height="1024"/></svg>`;
}

// Structural seats only. No constituency allocation feed is connected, so no
// seat receives a party colour from national or state vote shares.
export function seatChamber(total) {
  const rows=total>200?8:5,weights=Array.from({length:rows},(_,i)=>60+i*20),weight=weights.reduce((a,b)=>a+b,0);
  let left=total;const dots=[];
  weights.forEach((r,row)=>{const n=row===rows-1?left:Math.round(total*r/weight);left-=n;for(let i=0;i<n;i++){const a=Math.PI-Math.PI*(i+.5)/n;dots.push(`<circle cx="${(230+r*Math.cos(a)).toFixed(2)}" cy="${(220-r*Math.sin(a)).toFixed(2)}" r="${total>200?4:6}" fill="#c9d3de" stroke="#778b9e" stroke-width="1"/>`);}});
  return `<svg viewBox="0 0 460 260" xmlns="http://www.w3.org/2000/svg"><g>${dots.join('')}</g><text x="230" y="213" text-anchor="middle" fill="#152842" font-family="sans-serif" font-size="22" font-weight="700">${total} seats</text><text x="230" y="239" text-anchor="middle" fill="#40516b" font-family="sans-serif" font-size="15">Unassigned</text></svg>`;
}

export function civicIcon(race) {
  const paths = {
    president: '<path d="M18 49h60v18H18zM25 40h46v9H25zM33 39a15 13 0 0 1 30 0M48 17v9M48 17h16l-3 5H48"/><path d="M27 53v10m10-10v10m12-10v10m12-10v10m10-10v10M13 70h70"/>',
    senate: '<path d="M13 55a35 35 0 0 1 70 0M22 55a26 26 0 0 1 52 0M31 55a17 17 0 0 1 34 0M42 56h12v13H42zM33 71h30"/><path d="M23 48l-8-3m14-10-6-6m17 1-3-9m20 9 3-9m9 14 6-6m-2 19 8-3"/>',
    house: '<path d="M14 39l34-18 34 18zM20 43v24m14-24v24m14-24v24m14-24v24m14-24v24M13 70h70M18 76h60"/><path d="M39 34h18"/>',
  };
  return `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="metal-${race}" x2=".8" y2="1"><stop stop-color="#fff5cb"/><stop offset=".35" stop-color="#efc46b"/><stop offset=".6" stop-color="#a66b1b"/><stop offset="1" stop-color="#ffdc8d"/></linearGradient></defs><circle cx="48" cy="49" r="44" fill="#071c32" stroke="#dbb66e" stroke-width="2"/><circle cx="48" cy="47" r="39" fill="none" stroke="#ffffff" stroke-opacity=".25"/><g transform="translate(0 3)" fill="none" stroke="#030b15" stroke-width="5" stroke-linejoin="round">${paths[race] ?? paths.house}</g><g fill="none" stroke="url(#metal-${race})" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round">${paths[race] ?? paths.house}</g></svg>`;
}

export function chamberArt(dots, colour, hidden, compact) {
  let offset = 0;
  const marks = [12,16,20,24,28].map((count, row) => {
    const radius = 66 + row * 27;
    return Array.from({length:count}, (_, i) => {
      const party = dots[offset++], angle = Math.PI - Math.PI * (i + .5) / count;
      const active = party && !hidden.has(party);
      return `<circle cx="${(230 + radius * Math.cos(angle)).toFixed(2)}" cy="${(217 - radius * Math.sin(angle)).toFixed(2)}" r="7.2" fill="${active ? colour[party] ?? '#64748b' : '#c9d3de'}" stroke="${active ? '#fff' : '#8b9bac'}" stroke-width="1.4"/>`;
    }).join('');
  }).join('');
  return `<svg viewBox="0 0 460 250" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="rostrum" x2="0" y2="1"><stop stop-color="#eef3fa"/><stop offset="1" stop-color="#8a9daf"/></linearGradient></defs><g transform="translate(230 217) scale(${compact.toFixed(3)}) translate(-230 -217)">${marks}</g><path d="M187 223h86l13 13H174z" fill="url(#rostrum)" stroke="#74879b"/><path d="M210 209h40v16h-40z" fill="url(#rostrum)" stroke="#74879b"/></svg>`;
}
