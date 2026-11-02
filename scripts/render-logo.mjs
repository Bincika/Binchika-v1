// Rasterises the agogo mark into transparent, web-optimised PNGs.
// Usage: node scripts/render-logo.mjs   (installs @resvg/resvg-js on demand via npx cache)
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let Resvg;
try {
  ({ Resvg } = require("@resvg/resvg-js"));
} catch {
  execSync("npm i --no-save @resvg/resvg-js@2.6.2", { stdio: "inherit" });
  ({ Resvg } = require("@resvg/resvg-js"));
}

const IMG = "site/assets/img/";
const svg = await readFile(IMG + "agogo-mark.svg", "utf8");
const sizes = { "agogo-1024.png": 1024, "agogo-512.png": 512, "apple-touch-icon.png": 180, "icon-192.png": 192, "favicon-32.png": 32 };
for (const [name, width] of Object.entries(sizes)) {
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width }, background: name === "apple-touch-icon.png" ? "#F4EFE6" : undefined }).render().asPng();
  await writeFile(IMG + name, png);
  console.log(name, width, png.length, "bytes");
}
await copyFile(IMG + "agogo-mark.svg", "site/favicon.svg");
