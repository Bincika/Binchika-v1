// Page-load measurement on a Nigeria-realistic mobile profile (Slow 4G, 4x CPU throttle, cold cache).
// Usage: node scripts/perf.mjs https://binchika.com [/ /map/ …]   → prints a markdown table
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const base = (process.argv[2] ?? "https://binchika.com").replace(/\/$/, "");
const paths = process.argv.slice(3).length ? process.argv.slice(3) : ["/", "/tally/", "/map/", "/parties/", "/ledger/", "/verifiers/", "/about/", "/portal/"];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const host = new URL(base).host;
console.log("| Page | LCP | DOMContentLoaded | Load | Requests | Third-party origins | Transferred |");
console.log("|---|---:|---:|---:|---:|---:|---:|");
for (const p of paths) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.emulateNetworkConditions(puppeteer.PredefinedNetworkConditions["Slow 4G"]);
  await page.emulateCPUThrottling(4);
  let bytes = 0, reqs = 0; const origins = new Set();
  cdp.on("Network.loadingFinished", (e) => { bytes += e.encodedDataLength; });
  cdp.on("Network.requestWillBeSent", (e) => { reqs++; try { const h = new URL(e.request.url).host; if (h && h !== host) origins.add(h); } catch {} });
  await page.evaluateOnNewDocument(() => { window.__lcp = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true }); });
  await page.goto(base + p, { waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  const t = await page.evaluate(() => { const n = performance.getEntriesByType("navigation")[0]; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, lcp: window.__lcp }; });
  const s = (ms) => (ms / 1000).toFixed(1) + " s";
  console.log(`| ${p} | ${s(t.lcp)} | ${s(t.dcl)} | ${s(t.load)} | ${reqs} | ${origins.size} (${[...origins].map((o) => o.split(".").slice(-2).join(".")).filter((v, i, a) => a.indexOf(v) === i).join(", ")}) | ${(bytes / 1024).toFixed(0)} KB |`);
  await page.close();
}
await browser.close();
