// Negative probes only; no valid application, report, token or email recipient is used.
// Preview may deliberately lack authentication configuration. This does not test signed-in flows.
import assert from 'node:assert/strict';
const base = new URL(process.argv[2] ?? 'https://binchika.com');
assert.ok(['http:', 'https:'].includes(base.protocol));
let checks = 0;
const check = (ok, label) => {assert.ok(ok, label);checks++;console.log('PASS '+label);};
const get = async path => {const r=await fetch(new URL(path,base));return {status:r.status,body:await r.json()};};
const post = async (path, body) => fetch(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const intake = await get('/api/apply');
check(intake.status===200 && intake.body.open===false,'applications explicitly closed before negative POST probes');
const config = await get('/api/config');
check(config.status===200,'public configuration reachable');
const unconfigured = config.body.signIn===false;
const health = await get('/api/health');
check(health.status===200 && health.body.telegram===false,'Telegram remains disabled');
check((await post('/api/apply',{})).status===403,'empty application refused while closed (403)');
const reportStatus = (await post('/api/reports',{})).status;
check(reportStatus===401 || (unconfigured && health.body.ingest===false && reportStatus===503),'unauthenticated report refused (401, or unconfigured preview 503)');
const telegramStatus = (await post('/api/telegram',{})).status;
check([401,503].includes(telegramStatus),'disabled Telegram refuses unauthenticated input (401/503)');
check((await post('/api/pipeline/ocr',{})).status===401,'unauthenticated OCR refused (401)');
if(unconfigured) {
  check((await post('/api/auth/link',{})).status===503,'unconfigured preview authentication fails closed (503); signed-in flows untested');
} else console.log('NOTE authentication configured; production generic-response assertion belongs to e2e-apply --closed-only');
console.log(`PASS ${checks} closure checks; no valid application/report submitted`);
