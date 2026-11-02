// Deterministic derivative of existing Binchika artwork. No external media/model call.
import sharp from 'sharp';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const source = 'Media/Man_holding_election.jpg';
const target = 'site/assets/img/home/civic-portrait.webp';
const input = await readFile(source);
await mkdir('site/assets/img/home', {recursive:true});
await sharp(input).extract({left:90,top:260,width:890,height:900}).resize({width:600}).webp({quality:72,effort:6}).toFile(target);
const bytes = await readFile(target);
if(bytes.length > 102400) throw new Error('Home artwork exceeds 100KiB budget');
await writeFile('docs/egm/home-3d/art-provenance.json', JSON.stringify({
  source, sourceSha256:createHash('sha256').update(input).digest('hex'), target,
  targetSha256:createHash('sha256').update(bytes).digest('hex'),
  treatment:'Crop and resize only; source provenance not independently established. Illustrative artwork, not an election photograph.',
  crop:{left:90,top:260,width:890,height:900}, outputWidth:600,
},null,2)+'\n');
console.log(`PASS home artwork: ${bytes.length} bytes; provenance recorded`);
