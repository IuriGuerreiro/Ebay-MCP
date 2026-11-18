#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";

// Load .env from the project root if present.
try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); } catch {}
const { getItem, search, SHIP_TO, stats } = await import("./ebay.js");

const money = (p) => (p ? `${p.value} ${p.currency}` : null);

function timeLeft(end) {
  if (!end) return null;
  const ms = new Date(end) - Date.now();
  if (ms <= 0) return "ended";
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
}

/** Compact view used for both search results and item details. */
function summarize(it) {
  const auction = it.buyingOptions?.includes("AUCTION");
  return {
    itemId: it.itemId,
    legacyId: it.legacyItemId,
    title: it.title,
    url: it.itemWebUrl,
    type: auction ? "auction" : "fixed_price",
    buyingOptions: it.buyingOptions,
    price: money(it.price), // Buy It Now / fixed price
    currentBid: money(it.currentBidPrice),
    bidCount: it.bidCount ?? (auction ? 0 : undefined),
    minimumBidToPlace: money(it.minimumPriceToBid),
    reserveMet: it.reservePriceMet,
    shipping: money(it.shippingOptions?.[0]?.shippingCost),
    condition: it.condition,
    seller: it.seller && {
      username: it.seller.username,
      feedbackScore: it.seller.feedbackScore,
      feedbackPercent: it.seller.feedbackPercentage,
    },
    location: it.itemLocation && [it.itemLocation.city, it.itemLocation.country].filter(Boolean).join(", "),
    endsAt: it.itemEndDate,
    timeLeft: timeLeft(it.itemEndDate),
    available: it.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity,
    sold: it.estimatedAvailabilities?.[0]?.estimatedSoldQuantity,
  };
}

const clean = (o) => JSON.parse(JSON.stringify(o)); // drop undefined
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(clean(data), null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e.message || e) }] });

const server = new McpServer({ name: "ebay-mcp", version: "0.1.0" });

const searchShape = {
  query: z.string().optional().describe("Keywords"),
  categoryId: z.string().optional(),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  currency: z.string().optional().describe("Only needed for unknown marketplaces; set automatically per site"),
  conditions: z.array(z.enum(["NEW", "USED", "UNSPECIFIED"])).optional(),
  sellers: z.array(z.string()).optional(),
  sort: z.enum(["price", "-price", "newlyListed", "endingSoonest"]).optional(),
  limit: z.number().int().min(1).max(200).optional().describe("Default 20. With EUROPE, total = unique matches across all sites; use offset = nextOffset to page. Responses are capped at ~8 KB, so fewer items than limit may come back. Use specific queries, minPrice and categoryId to cut accessory noise."),
  offset: z.number().int().min(0).optional(),
  maxResults: z.number().int().min(1).max(1000).optional().describe("Cap on results you can page through (default 200)"),
  marketplace: z.string().optional().describe("EUROPE (all EU sites), a site like EBAY_DE, or a comma list. Prices are in each site's own currency."),
};

function row(it) {
  const s = summarize(it);
  const url = s.url?.split("?")[0];
  const price = s.currentBid ? `bid ${s.currentBid}` : s.price ?? "?";
  const bin = s.currentBid && s.price ? ` (BIN ${s.price})` : "";
  return [price + bin, s.bidCount ?? "-", s.shipping ?? "?", s.condition ?? "?", s.timeLeft ?? "?",
    s.seller?.feedbackPercent ?? "?", (it.marketplace || "").replace("EBAY_", ""), s.title?.slice(0, 90), url].join(" | ");
}

const MAX_CHARS = 8000; // keep each response well under agent tool-output limits

async function runSearch(args) {
  if (!args.query && !args.categoryId) throw new Error("Provide query or categoryId.");
  const r = await search(args);
  const offset = r.offset ?? args.offset ?? 0, matches = r.total ?? 0;
  const cap = args.maxResults ?? 200; // never page past the top `cap` results
  const total = Math.min(matches, cap);
  const items = [];
  let size = 0;
  for (const it of (r.itemSummaries || []).slice(0, Math.max(0, total - offset))) {
    const line = row(it);
    if (items.length && size + line.length > MAX_CHARS) break;
    items.push(line); size += line.length + 4;
  }
  const next = offset + items.length;
  const perSite = r.perSite && Object.fromEntries(Object.entries(r.perSite).map(([k, v]) =>
    [k.replace("EBAY_", ""), v.error ? "error" : `${v.matches}${v.truncated ? " (truncated)" : ""}`]));
  return {
    total, matches: matches > total ? matches : undefined, offset, returned: items.length,
    note: matches > total ? `Showing top ${total} of ${matches} matches. Use a more specific query or minPrice to see others.` : undefined,
    nextOffset: next < total ? next : undefined, // call again with offset = nextOffset
    columns: "price | bids | shipping | condition | timeLeft | seller% | site | title | url",
    items,
    errors: r.errors?.length ? r.errors : undefined,
    perSite,
  };
}

server.tool(
  "search_listings",
  "Search eBay listings (auctions and/or Buy It Now). Filter by type, price, condition, seller.",
  {
    ...searchShape,
    listingType: z.enum(["all", "auction", "buy_it_now", "best_offer"]).optional(),
  },
  async (a) => {
    try {
      const map = { auction: ["AUCTION"], buy_it_now: ["FIXED_PRICE"], best_offer: ["BEST_OFFER"] };
      return ok(await runSearch({ ...a, buyingOptions: map[a.listingType] }));
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "search_auctions",
  "Find live auctions, ending soonest first by default. Shows current bid, bid count, time left.",
  { ...searchShape, endingWithinHours: z.number().optional().describe("Only auctions ending within N hours") },
  async (a) => {
    try {
      return ok(await runSearch({ sort: "endingSoonest", ...a, buyingOptions: ["AUCTION"] }));
    } catch (e) { return fail(e); }
  },
);

// ---- scan_deals: many queries at once, merged, in EUR, noise filtered ----
const FALLBACK_RATES = { EUR: 1, GBP: 0.85, CHF: 0.94, PLN: 4.3 }; // units per 1 EUR
let rates = null;
async function eurRates() {
  if (rates && Date.now() - rates.at < 6 * 3600_000) return rates.r;
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=EUR", { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    rates = { at: Date.now(), r: { EUR: 1, ...j.rates } };
  } catch { rates = { at: Date.now(), r: FALLBACK_RATES }; }
  return rates.r;
}
async function mapLimit(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}
const shipCache = new Map();
async function shipInfo(it) {
  const hit = shipCache.get(it.itemId);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  let v = null;
  try {
    const d = await getItem(it.itemId, it.marketplace);
    const inc = (d.shipToLocations?.regionIncluded || []).map((x) => x.regionId);
    const exc = (d.shipToLocations?.regionExcluded || []).map((x) => x.regionId);
    const ships = exc.includes(SHIP_TO) ? false
      : inc.some((x) => x === SHIP_TO || x === "WORLDWIDE" || x === "EUROPE" || x === "EUROPEAN_UNION") ? true
      : inc.length ? false : null;
    v = { ships, cost: ships ? d.shippingOptions?.[0]?.shippingCost : null };
  } catch {}
  shipCache.set(it.itemId, { at: Date.now(), v });
  return v;
}
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
const toEur = (p, r) => (p && r[p.currency] ? parseFloat(p.value) / r[p.currency] : null);

const NOISE = /(h[üu]lle|\bcase\b|cover|schutz|panzerglas|protector|kabel|\bcable|charger|lade(ger[äa]t|kabel)|adapter|sticker|\bskin|etui|tasche|custodi|coque|funda|pellicola|scatol|\bbox only|leerkarton|\bovp only|nur ovp|empty box|\bdisplay\b|\blcd\b|\boled\b|bildschirm|kamera|camera|\bakku|battery|batteri|\btester|\btest board|ersatzteil|spare part|ricambi|flex|backcover|r[üu]ckseite|geh[äa]use|housing|frame|rahmen|keyboard only|tastatur only|\bmanual|anleitung|poster|figur|card\b|sammelkarte|teller|plate|piatto|vase)/i;

server.tool(
  "scan_deals",
  "Run many auction searches across EUROPE in one call. Results are merged, de-duplicated, converted to EUR, " +
  "filtered (min price, accessory words), then ranked by price vs the median of the same query (cheapest first, top 150). Use this first for deal hunting, then get_listing on candidates.",
  {
    queries: z.array(z.string()).min(1).max(40).describe("Specific phrases, e.g. 'DDR5 32GB', 'PowerEdge', 'iPhone 15 Pro'"),
    endingWithinHours: z.number().optional().describe("Default 24"),
    minEur: z.number().optional().describe("Drop items whose bid+shipping is below this (default 30)"),
    maxEur: z.number().optional(),
    excludeAccessories: z.boolean().optional().describe("Default true: drop cases, cables, chargers, empty boxes"),
    marketplace: z.string().optional().describe("Default EUROPE"),
    maxRatio: z.number().optional().describe("Keep items priced at most this fraction of their query's median (default 0.6). Use 0 to disable ranking and get everything"),
    minRatio: z.number().optional().describe("Drop items below this fraction of the median (default 0.15; usually junk)"),
    shipCheck: z.number().int().min(0).max(300).optional().describe("How many top candidates to check for delivery to EBAY_SHIP_TO (default 80; each costs one API call)"),
    maxResults: z.number().int().min(1).max(2000).optional().describe("Cap on ranked results (default 150)"),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  },
  async (a) => {
    try {
      const r = await eurRates();
      const calls0 = stats.calls;
      const minEur = a.minEur ?? 30, hours = a.endingWithinHours ?? 24;
      const runs = await Promise.allSettled(a.queries.map((q) => search({
        query: q, marketplace: a.marketplace ?? "EUROPE", buyingOptions: ["AUCTION"],
        endingWithinHours: hours, sort: "endingSoonest", limit: 1000, maxPerSite: 400,
      })));
      const seen = new Map(), perQuery = {}, errors = [], byQuery = {};
      runs.forEach((res, i) => {
        const q = a.queries[i];
        if (res.status === "rejected") { perQuery[q] = "error"; errors.push(`${q}: ${res.reason?.message}`); return; }
        let kept = 0;
        for (const it of res.value.itemSummaries || []) {
          const bid = toEur(it.currentBidPrice || it.price, r);
          const ship = toEur(it.shippingOptions?.[0]?.shippingCost, r) ?? 0;
          if (bid == null) continue;
          const tot = bid + ship;
          if (tot < minEur || (a.maxEur != null && tot > a.maxEur)) continue;
          if (a.excludeAccessories !== false && NOISE.test(it.title || "")) continue;
          kept++;
          const prev = seen.get(it.itemId);
          if (prev) { prev.q.add(q); continue; }
          const d = { it, bid, ship, tot, q: new Set([q]) };
          seen.set(it.itemId, d); (byQuery[q] ||= []).push(d);
        }
        perQuery[q] = `${res.value.total} matches, ${kept} kept`;
        for (const e of res.value.errors || []) errors.push(`${q}: ${e}`);
      });
      // Rank: price vs the median of the same query (a cheap "below typical" signal).
      for (const list of Object.values(byQuery)) {
        const t = list.map((d) => d.tot).sort((x, y) => x - y);
        const med = t[Math.floor(t.length / 2)];
        for (const d of list) if (d.median == null || med < d.median) { d.median = med; d.ratio = d.tot / med; }
      }
      const maxRatio = a.maxRatio ?? 0.6;
      let all = [...seen.values()];
      const scanned = all.length;
      const minRatio = a.minRatio ?? 0.15; // below this is almost always parts/accessories
      if (maxRatio > 0) all = all.filter((d) => d.ratio <= maxRatio && d.ratio >= minRatio).sort((x, y) => x.ratio - y.ratio);
      else all.sort((x, y) => new Date(x.it.itemEndDate) - new Date(y.it.itemEndDate));
      const cap = a.maxResults ?? 150;
      // Check delivery to EBAY_SHIP_TO (and quote shipping there) for the best-ranked items,
      // keeping the first `cap` that ship. At most 2×cap detail calls; cached 30 min.
      let droppedNoShip = 0, checked = 0;
      if (SHIP_TO) {
        const pool = all.slice(0, a.shipCheck ?? 80), keep = [];
        for (let i = 0; i < pool.length && keep.length < cap; i += 20) {
          const batch = pool.slice(i, i + 20);
          await mapLimit(batch, 10, async (d) => {
            const det = await shipInfo(d.it);
            d.shipsTo = det?.ships;
            if (det?.cost) { d.ship = toEur(det.cost, r) ?? d.ship; d.tot = d.bid + d.ship; }
          });
          checked += batch.length;
          for (const d of batch) d.shipsTo === false ? droppedNoShip++ : keep.push(d);
        }
        all = [...keep, ...all.slice(pool.length).map((d) => ((d.shipsTo = null), d))].slice(0, cap);
      } else all = all.slice(0, cap);
      const offset = a.offset ?? 0, limit = a.limit ?? 200;
      const items = []; let size = 0;
      for (const d of all.slice(offset, offset + limit)) {
        const s = summarize(d.it);
        const orig = d.it.currentBidPrice || d.it.price;
        const line = [`€${d.tot.toFixed(0)} (bid ${orig.value} ${orig.currency} + ship €${d.ship.toFixed(0)})`,
          `${Math.round(d.ratio * 100)}% of median €${d.median.toFixed(0)}`,
          (SHIP_TO && d.shipsTo == null ? "ship? " : "") + (s.bidCount ?? 0), s.condition ?? "?", s.timeLeft, s.seller?.feedbackPercent ?? "?",
          `${(d.it.marketplace || "").replace("EBAY_", "")} from ${d.it.itemLocation?.country ?? "?"}${EU.has(d.it.itemLocation?.country) ? "" : " ⚠import"}`, s.title?.slice(0, 90), s.url?.split("?")[0]].join(" | ");
        if (items.length && size + line.length > MAX_CHARS) break;
        items.push(line); size += line.length + 4;
      }
      const next = offset + items.length;
      return ok({
        NEXT_PAGE: next < all.length
          ? `Items ${offset + 1}-${next} of ${all.length}. MORE REMAIN: call scan_deals again with the same queries and offset: ${next}`
          : `Items ${offset + 1}-${next} of ${all.length}. This is the last page.`,
        apiCalls: stats.calls - calls0,
        scanned, candidates: all.length, offset, returned: items.length,
        nextOffset: next < all.length ? next : undefined,
        columns: "total EUR (original bid + ship) | vs query median | bids | condition | timeLeft | seller% | site from country (⚠import = outside EU, customs/VAT likely) | title | url",
        shipping: SHIP_TO ? `Top ${checked} checked: dropped ${droppedNoShip} that don't ship to ${SHIP_TO}; shipping for those is quoted to ${SHIP_TO}. Lines marked "ship?" were not checked.`
          : "Shipping is the seller's default (set EBAY_SHIP_TO to check delivery).",
        items, perQuery, errors: errors.length ? errors.slice(0, 20) : undefined,
        ratesNote: rates.r === FALLBACK_RATES ? "Live rates unavailable; approximate rates used" : undefined,
      });
    } catch (e) { return fail(e); }
  },
);

server.tool(
  "get_listing",
  "Full details for one listing. Accepts an eBay URL, legacy item number, or v1|…|0 item id.",
  {
    item: z.string(),
    includeDescription: z.boolean().optional(),
    marketplace: z.string().optional(),
  },
  async ({ item, includeDescription, marketplace }) => {
    try {
      const it = await getItem(item, marketplace);
      return ok({
        ...summarize(it),
        brand: it.brand,
        category: it.categoryPath,
        returns: it.returnTerms && { accepted: it.returnTerms.returnsAccepted, days: it.returnTerms.returnPeriod?.value },
        specifics: Object.fromEntries((it.localizedAspects || []).map((x) => [x.name, x.value])),
        images: [it.image?.imageUrl, ...(it.additionalImages || []).map((x) => x.imageUrl)].filter(Boolean),
        description: includeDescription ? (it.shortDescription || it.description?.replace(/<[^>]+>/g, " ").slice(0, 4000)) : undefined,
      });
    } catch (e) { return fail(e); }
  },
);

// In-memory snapshots so repeated checks can report what changed.
const lastSeen = new Map();

server.tool(
  "check_listings",
  "Check status of one or more listings (bids, price, time left, ended). Reports changes since the previous check in this session. Optionally flag listings over your max budget.",
  {
    items: z.array(z.string()).min(1).max(50),
    maxPrice: z.number().optional().describe("Your budget; flags items whose current price/bid exceeds it"),
    marketplace: z.string().optional(),
  },
  async ({ items, maxPrice, marketplace }) => {
    const results = await Promise.all(items.map(async (ref) => {
      try {
        const s = summarize(await getItem(ref, marketplace));
        const prev = lastSeen.get(s.itemId);
        const changes = [];
        if (prev) {
          if (prev.currentBid !== s.currentBid) changes.push(`bid ${prev.currentBid} → ${s.currentBid}`);
          if (prev.bidCount !== s.bidCount) changes.push(`bids ${prev.bidCount} → ${s.bidCount}`);
          if (prev.price !== s.price) changes.push(`price ${prev.price} → ${s.price}`);
          if (prev.available !== s.available) changes.push(`available ${prev.available} → ${s.available}`);
        }
        lastSeen.set(s.itemId, s);
        const now = parseFloat(s.currentBid ?? s.price);
        return clean({
          ref, itemId: s.itemId, title: s.title, url: s.url, type: s.type,
          currentBid: s.currentBid, bidCount: s.bidCount, minimumBidToPlace: s.minimumBidToPlace,
          reserveMet: s.reserveMet, price: s.price, timeLeft: s.timeLeft, endsAt: s.endsAt,
          available: s.available,
          overBudget: maxPrice != null ? now > maxPrice : undefined,
          changesSinceLastCheck: prev ? (changes.length ? changes : "none") : "first check",
        });
      } catch (e) {
        // Ended/removed listings usually 404.
        return { ref, error: String(e.message).slice(0, 300) };
      }
    }));
    return ok(results);
  },
);

await server.connect(new StdioServerTransport());
