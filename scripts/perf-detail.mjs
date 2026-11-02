// Per-request waterfall for one page on the same Slow 4G / 4x CPU profile as scripts/perf.mjs: what loads, how big,
// when it finishes, and which element is the LCP. Usage: node scripts/perf-detail.mjs https://binchika.com /portal/
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const [base, path = "/"] = [(process.argv[2] ?? "https://binchika.com").replace(/\/$/, ""), process.argv[3]];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
const cdp = await page.createCDPSession();
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
await page.emulateNetworkConditions(puppeteer.PredefinedNetworkConditions["Slow 4G"]);
await page.emulateCPUThrottling(4);
const reqs = new Map(); let t0 = null;
cdp.on("Network.requestWillBeSent", (e) => { t0 ??= e.timestamp; reqs.set(e.requestId, { url: e.request.url, start: e.timestamp, type: e.type, prio: e.request.initialPriority }); });
cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.kb = e.encodedDataLength / 1024; } });
await page.evaluateOnNewDocument(() => { window.__lcp = null; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = { t: e.startTime, el: e.element ? `${e.element.tagName.toLowerCase()}${e.element.id ? "#" + e.element.id : ""}${e.element.className ? "." + String(e.element.className).split(" ")[0] : ""}` : null, url: e.url, size: e.size }; }).observe({ type: "largest-contentful-paint", buffered: true }); });
await page.goto(base + path, { waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1500));
const t = await page.evaluate(() => ({ dcl: performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd, lcp: window.__lcp }));
console.log(`${path}: LCP ${(t.lcp?.t / 1000).toFixed(2)} s on ${t.lcp?.el} ${t.lcp?.url ? "(" + t.lcp.url.split("/").pop() + ")" : ""} · DCL ${(t.dcl / 1000).toFixed(2)} s`);
console.log("start  end    KB    prio      type        url");
for (const r of [...reqs.values()].sort((a, b) => a.start - b.start)) {
  const u = r.url.replace(base, "").slice(0, 70);
  console.log(`${(r.start - t0).toFixed(2).padStart(5)} ${r.end ? (r.end - t0).toFixed(2).padStart(5) : "  -  "} ${(r.kb ?? 0).toFixed(0).padStart(5)}  ${String(r.prio).padEnd(9)} ${String(r.type).padEnd(11)} ${u}`);
}
await browser.close();
