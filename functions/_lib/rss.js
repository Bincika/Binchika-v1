// Minimal, dependency-free RSS/Atom parsing for headline + link + date. Pure.

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

const pick = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decode(m[1]) : "";
};

export function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const b of blocks) {
    const title = pick(b, "title");
    let link = pick(b, "link");
    if (!link) link = b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "";
    const date = pick(b, "pubDate") || pick(b, "updated") || pick(b, "published") || pick(b, "dc:date");
    const t = Date.parse(date);
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, source, publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString() });
  }
  return items;
}

export const ELECTION_TERMS = /\b(INEC|IReV|BVAS|election|electoral|elections|poll|polls|polling|vote|votes|voters?|ballot|PVC|campaign|governorship|presidential|primaries|primary|candidate|National Assembly|Senate|collation|tribunal|2027)\b/i;

export function electionOnly(items) {
  return items.filter((i) => ELECTION_TERMS.test(i.title));
}

/** De-duplicates, then interleaves sources round-robin (newest first within each) so no outlet dominates. */
export function mergeLatest(lists, limit = 24) {
  const seen = new Set();
  const now = Date.now() + 5 * 60e3;
  const clean = lists.map((l) => l
    .filter((i) => { const k = i.link.replace(/[?#].*$/, ""); if (seen.has(k)) return false; seen.add(k); return true; })
    .map((i) => (i.publishedAt && Date.parse(i.publishedAt) > now ? { ...i, publishedAt: null } : i)) // future-dated feeds
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")));
  const out = [];
  for (let round = 0; out.length < limit && clean.some((l) => l[round]); round++) {
    const layer = clean.map((l) => l[round]).filter(Boolean).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    out.push(...layer);
  }
  return out.slice(0, limit);
}
