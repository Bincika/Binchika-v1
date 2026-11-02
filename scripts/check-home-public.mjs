// Public-page regression on the secret-free preview. Does not replace production smoke.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base = new URL(process.argv[2] ?? 'https://binchika.com');
assert.ok(['https:','http:'].includes(base.protocol));
let checks = 0;
const check = (ok,label) => {assert.ok(ok,label);checks++;console.log('PASS '+label);};
const main = html => html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1].replace(/\?v=[a-z0-9]+/g,'?v=BUILD').trim();
for (const path of ['/', '/media/', '/map/', '/sources/', '/verifiers/']) {
  const response = await fetch(new URL(path,base));
  check(response.status===200,`${path} returns 200`);
  const remote = await response.text();
  const local = await readFile(`site${path}index.html`,'utf8');
  check(!!main(local) && main(remote)===main(local),`${path} complete main content matches the verified local build`);
  check(remote.includes('Only') && remote.includes('declares election results in Nigeria'),`${path} retains the shared INEC notice`);
}
const missing = await fetch(new URL('/home-session94-missing-check',base));
check(missing.status===404,'unknown page retains genuine HTTP 404');
console.log(`PASS ${checks} public-page checks; authentication, seats and mail are outside this preview check`);
