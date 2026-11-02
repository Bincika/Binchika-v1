// Headless visual check with the locally installed Chrome (software WebGL), independent of any preview pane.
// Usage: node scripts/shot.mjs <url> <out.png> [--width 1280] [--height 900] [--dark] [--eval "js"] [--wait 4000] [--full]
// Prints console errors and the --eval result as JSON. Screenshots go wherever you point them (use the scratchpad).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let puppeteer;
puppeteer = require("puppeteer-core"); // devDependency

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [url, out] = args;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-first-run"] });
const page = await browser.newPage();
await page.setViewport({ width: Number(opt("--width", 1280)), height: Number(opt("--height", 900)), deviceScaleFactor: 1 });
if (args.includes("--dark")) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, Number(opt("--wait", 3500))));
let evalResult = null;
const js = opt("--eval");
if (js) { evalResult = await page.evaluate(`(async () => { ${js} })()`); await new Promise((r) => setTimeout(r, Number(opt("--wait", 3500)))); }
if (out) await page.screenshot({ path: out, fullPage: args.includes("--full") });
console.log(JSON.stringify({ errors, evalResult }, null, 1));
await browser.close();
