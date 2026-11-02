// Draws fictional Form EC8A sandbox sheets and degraded copies. No people, no real unit.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

const FONTS = {
  print: "C:/Windows/Fonts/arial.ttf",
  hand: "C:/Windows/Fonts/Inkfree.ttf",
  handAlt: "C:/Windows/Fonts/segoesc.ttf",
};

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function sheetSvg(sheet, { font = "Arial", ink = "#1a1a1a", paper = "#ffffff", skew = 0 } = {}) {
  const rows = Object.entries(sheet.parties);
  const body = rows.map(([party, votes], i) => {
    const y = 280 + i * 72;
    return `<text x="80" y="${y}" font-size="48">${esc(party)}: ${esc(votes)}</text>`;
  }).join("");
  const foot = [
    ["Rejected ballots", sheet.rejected],
    ["Accredited voters", sheet.accredited],
    ["Register", sheet.register],
  ].map(([label, n], i) => `<text x="80" y="${280 + rows.length * 72 + 80 + i * 56}" font-size="32">${esc(label)} ${esc(n)}</text>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100">
  <rect width="900" height="1100" fill="${paper}"/>
  <g transform="skewX(${skew})" fill="${ink}" font-family="${esc(font)}">
    <text x="80" y="80" font-size="28">SANDBOX FORM EC8A</text>
    <text x="80" y="124" font-size="22">Fictional unit. Not an INEC result.</text>
    <text x="80" y="180" font-size="32">Code ${esc(sheet.puCode)}</text>
    <text x="80" y="224" font-size="28">Race ${esc(sheet.race)}</text>
    ${body}
    ${foot}
  </g>
</svg>`;
}

function raster(svg, fontFile) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: "Arial" },
  });
  return Buffer.from(resvg.render().asPng());
}

async function writePng(file, buffer) {
  mkdirSync(dirname(file), { recursive: true });
  await sharp(buffer).png().toFile(file);
}

/** @returns {Promise<{id: string, file: string, expectRead: boolean, note: string}[]>} */
export async function renderSheets(sheet, dir) {
  const out = resolve(dir);
  mkdirSync(out, { recursive: true });
  const clearSvg = sheetSvg(sheet, { font: "Arial" });
  const clear = raster(clearSvg, FONTS.print);
  const handFont = FONTS.hand;
  const hand = raster(sheetSvg(sheet, { font: "Ink Free" }), handFont);
  const made = [];

  const clearFile = resolve(out, "clear.png");
  await writePng(clearFile, clear);
  made.push({ id: "clear", file: clearFile, expectRead: true, note: "Printed Arial, full page, high contrast." });

  const handFile = resolve(out, "handwritten.png");
  await writePng(handFile, hand);
  made.push({ id: "handwritten", file: handFile, expectRead: false, note: "Ink Free glyphs. Handwriting-style, not a photograph of a real sheet." });

  const blurFile = resolve(out, "blurry.png");
  await writePng(blurFile, await sharp(clear).blur(4.5).png().toBuffer());
  made.push({ id: "blurry", file: blurFile, expectRead: false, note: "Same printed sheet, Gaussian blur sigma 4.5." });

  const skewFile = resolve(out, "skewed.png");
  await writePng(skewFile, raster(sheetSvg(sheet, { font: "Arial", skew: 18 }), FONTS.print));
  made.push({ id: "skewed", file: skewFile, expectRead: false, note: "Printed sheet skewed 18 degrees on the horizontal." });

  const lowFile = resolve(out, "low-contrast.png");
  await writePng(lowFile, raster(sheetSvg(sheet, { font: "Arial", ink: "#c5c5c5", paper: "#e6e6e6" }), FONTS.print));
  made.push({ id: "low-contrast", file: lowFile, expectRead: false, note: "Grey ink on a grey page." });

  const meta = await sharp(clear).metadata();
  const partialFile = resolve(out, "partial.png");
  await writePng(partialFile, await sharp(clear).extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.32) }).png().toBuffer());
  made.push({ id: "partial", file: partialFile, expectRead: false, note: "Top 32% only. Party rows and control totals are cut off." });

  return made;
}
