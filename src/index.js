#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fileURLToPath } from "node:url";

// Load .env from the project root if present.
try { process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))); } catch {}
const { getItem, search } = await import("./ebay.js");

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
