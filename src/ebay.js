// Minimal eBay Browse API client (app token via client credentials).
const ENV = (process.env.EBAY_ENV || "production").toLowerCase();
const HOST = ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const DEFAULT_MARKETPLACE = (process.env.EBAY_MARKETPLACE_ID || "EBAY_US").toUpperCase();

// Currency used by each marketplace (needed for price filters).
export const CURRENCY = {
  EBAY_US: "USD", EBAY_GB: "GBP", EBAY_DE: "EUR", EBAY_FR: "EUR", EBAY_IT: "EUR",
  EBAY_ES: "EUR", EBAY_NL: "EUR", EBAY_BE: "EUR", EBAY_AT: "EUR", EBAY_IE: "EUR",
  EBAY_CH: "CHF", EBAY_PL: "PLN", EBAY_CA: "CAD", EBAY_AU: "AUD",
};
const EUROPE = ["EBAY_DE", "EBAY_GB", "EBAY_FR", "EBAY_IT", "EBAY_ES", "EBAY_NL",
  "EBAY_BE", "EBAY_AT", "EBAY_IE", "EBAY_CH", "EBAY_PL"];

/** "EUROPE" → all EU sites; "EBAY_DE,EBAY_FR" → those; else one site. */
export function resolveMarketplaces(m) {
  const v = (m || DEFAULT_MARKETPLACE).toUpperCase();
  if (v === "EUROPE" || v === "EU") return EUROPE;
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

let token = null;
let tokenExpiresAt = 0;

let pending = null;

// Share one in-flight token request across parallel searches.
function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return Promise.resolve(token);
  pending ??= fetchToken().finally(() => { pending = null; });
  return pending;
}

async function fetchToken() {
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.");
  const res = await fetch(`${HOST}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });
  if (!res.ok) throw new Error(`eBay auth failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

export const stats = { calls: 0, quotaOut: false };
export const SHIP_TO = process.env.EBAY_SHIP_TO?.toUpperCase();

// At most MAX_INFLIGHT eBay requests at once; retry 429/5xx with backoff.
const MAX_INFLIGHT = 8;
let inflight = 0; const waiters = [];
async function slot() {
  if (inflight >= MAX_INFLIGHT) await new Promise((r) => waiters.push(r));
  inflight++;
}
function release() { inflight--; waiters.shift()?.(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, params = {}, marketplace, shipTo) {
  for (let attempt = 0; ; attempt++) {
    if (stats.quotaOut) throw new Error("eBay daily API quota exhausted (resets 08:00 UTC)");
    await slot();
    stats.calls++;
    let res;
    try { res = await rawCall(path, params, marketplace, shipTo); } finally { release(); }
    if (res.retry && attempt < 4) { await sleep(1000 * 2 ** attempt + Math.random() * 500); continue; }
    if (res.error) throw res.error;
    return res.data;
  }
}

async function rawCall(path, params, marketplace, shipTo) {
  marketplace = resolveMarketplaces(marketplace)[0];
  const url = new URL(HOST + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
      // Quote shipping to the buyer's country (EBAY_SHIP_TO, e.g. PT; optional EBAY_SHIP_ZIP).
      ...(shipTo && { "X-EBAY-C-ENDUSERCTX": `contextualLocation=${encodeURIComponent(
        `country=${shipTo}${process.env.EBAY_SHIP_ZIP ? `,zip=${process.env.EBAY_SHIP_ZIP}` : ""}`)}` }),
      Accept: "application/json",
    },
  });
  if (res.status === 204) return { data: {} };
  const body = await res.text();
  if (res.status === 429 && /Too many requests/.test(body)) {
    // errorId 2001 is the daily call quota for the app; retrying won't help.
    stats.quotaOut = true; setTimeout(() => { stats.quotaOut = false; }, 10 * 60_000);
    return { error: new Error("eBay daily API quota exhausted (resets 08:00 UTC)") };
  }
  if (res.status === 429 || res.status >= 500) return { retry: true, error: new Error(`eBay API ${res.status}: ${body.slice(0, 200)}`) };
  if (!res.ok) return { error: new Error(`eBay API ${res.status}: ${body}`) };
  return { data: JSON.parse(body) };
}

/** Accepts a v1|123|0 id, a plain legacy number, or an eBay /itm/ URL. */
export function parseItemRef(ref) {
  const s = String(ref).trim();
  if (s.startsWith("v1|")) return { itemId: s };
  const m = s.match(/\/itm\/(?:[^/?#]*\/)?(\d{9,15})/) || s.match(/^(\d{9,15})$/);
  if (m) return { legacyId: m[1] };
  throw new Error(`Can't parse item reference: ${ref}`);
}

export async function getItem(ref, marketplace) {
  const { itemId, legacyId } = parseItemRef(ref);
  if (itemId) return call(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {}, marketplace, SHIP_TO);
  try {
    return await call(
      "/buy/browse/v1/item/get_item_by_legacy_id",
      { legacy_item_id: legacyId },
      marketplace,
      SHIP_TO,
    );
  } catch (e) {
    // Multi-variation listings need the group endpoint.
    if (!String(e.message).includes("11006")) throw e;
    const group = await call(
      "/buy/browse/v1/item/get_items_by_item_group",
      { item_group_id: legacyId },
      marketplace,
    );
    return group.items?.[0] ?? group;
  }
}

const PAGE = 200;            // eBay max per request
const MAX_PER_SITE = 1000;  // pages fetched per site in multi-site mode

/** Fetch every page for one site (up to MAX_PER_SITE items). */
async function searchAllPages(opts) {
  const first = await searchOne({ ...opts, limit: PAGE, offset: 0 });
  const items = [...(first.itemSummaries || [])];
  const total = first.total ?? 0;
  const cap = opts.maxPerSite ?? MAX_PER_SITE;
  const want = Math.min(total, cap);
  const offsets = [];
  for (let o = PAGE; o < want; o += PAGE) offsets.push(o);
  const pages = await Promise.all(offsets.map((o) => searchOne({ ...opts, limit: PAGE, offset: o })));
  for (const p of pages) items.push(...(p.itemSummaries || []));
  return { total, items, truncated: total > cap, cap };
}

// Merged multi-site results are cached briefly so paging with offset doesn't refetch everything.
const mergedCache = new Map();
const CACHE_MS = 3 * 60_000;

export async function search(opts) {
  const sites = resolveMarketplaces(opts.marketplace);
  if (sites.length === 1) return searchOne({ ...opts, marketplace: sites[0] });
  const { offset = 0, limit = 20, ...rest } = opts;
  const key = JSON.stringify({ ...rest, sites });
  let hit = mergedCache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), data: searchMerged(rest, sites) };
    mergedCache.set(key, hit);
    hit.data.catch(() => mergedCache.delete(key));
  }
  const { items, errors, perSite } = await hit.data;
  return { total: items.length, offset, itemSummaries: items.slice(offset, offset + limit), errors, perSite };
}

/** Multi-site: fetch all pages per site, merge, dedupe, sort. */
async function searchMerged(opts, sites) {
  const results = await Promise.allSettled(sites.map((m) => searchAllPages({ ...opts, marketplace: m })));
  const seen = new Set();
  const items = [];
  const errors = [];
  const perSite = {};
  results.forEach((r, i) => {
    const site = sites[i];
    if (r.status === "rejected") {
      perSite[site] = { error: true };
      return errors.push(`${site}: ${String(r.reason.message).slice(0, 150)}`);
    }
    let added = 0;
    for (const it of r.value.items) {
      if (seen.has(it.itemId)) continue;
      seen.add(it.itemId);
      items.push({ ...it, marketplace: site });
      added++;
    }
    perSite[site] = { matches: r.value.total, fetched: r.value.items.length, newUnique: added,
      ...(r.value.truncated && { truncated: true }) };
    if (r.value.truncated) errors.push(`${site}: ${r.value.total} matches, only first ${r.value.cap} fetched — narrow the query`);
  });
  const price = (it) => parseFloat((it.currentBidPrice || it.price)?.value ?? "Infinity");
  const sorters = {
    price: (a, b) => price(a) - price(b),
    "-price": (a, b) => price(b) - price(a),
    endingSoonest: (a, b) => new Date(a.itemEndDate || 8e15) - new Date(b.itemEndDate || 8e15),
    newlyListed: (a, b) => new Date(b.itemCreationDate || 0) - new Date(a.itemCreationDate || 0),
  };
  if (sorters[opts.sort]) items.sort(sorters[opts.sort]);
  return { items, errors, perSite };
}

async function searchOne(opts) {
  const filters = [];
  if (opts.buyingOptions?.length) filters.push(`buyingOptions:{${opts.buyingOptions.join("|")}}`);
  if (opts.minPrice != null || opts.maxPrice != null) {
    filters.push(`price:[${opts.minPrice ?? ""}..${opts.maxPrice ?? ""}]`);
    filters.push(`priceCurrency:${CURRENCY[opts.marketplace] || opts.currency || "USD"}`);
  }
  if (opts.conditions?.length) filters.push(`conditions:{${opts.conditions.join("|")}}`);
  if (opts.endingWithinHours != null) {
    const end = new Date(Date.now() + opts.endingWithinHours * 3600_000).toISOString();
    filters.push(`itemEndDate:[..${end}]`);
  }
  if (opts.sellers?.length) filters.push(`sellers:{${opts.sellers.join("|")}}`);
  return call(
    "/buy/browse/v1/item_summary/search",
    {
      q: opts.query,
      category_ids: opts.categoryId,
      filter: filters.join(",") || undefined,
      sort: opts.sort,
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
    },
    opts.marketplace,
  );
}
