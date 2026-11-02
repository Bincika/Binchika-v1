// Optimise the original decorative artwork; no remote image dependencies.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
await mkdir('site/assets/img/dashboard', {recursive:true});
await sharp('Media/tally-civic-art.png').resize({width:1152,withoutEnlargement:true}).webp({quality:70,effort:6}).toFile('site/assets/img/dashboard/nigerian-civic-art.webp');
await sharp('Media/banchika_v1.png').resize({width:192}).png().toFile('site/assets/img/dashboard/binchika-transparent.png');
console.log('Dashboard artwork and transparent logo optimised.');
