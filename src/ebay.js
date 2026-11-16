// Minimal eBay Browse API client (app token via client credentials).
const ENV = (process.env.EBAY_ENV || "production").toLowerCase();
const HOST = ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const DEFAULT_MARKETPLACE = process.env.EBAY_MARKETPLACE_ID || "EBAY_US";

let token = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;
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

async function call(path, params = {}, marketplace = DEFAULT_MARKETPLACE) {
  const url = new URL(HOST + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
      Accept: "application/json",
    },
  });
  if (res.status === 204) return {};
  const body = await res.text();
  if (!res.ok) throw new Error(`eBay API ${res.status}: ${body}`);
  return JSON.parse(body);
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
  if (itemId) return call(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`, {}, marketplace);
  try {
    return await call(
      "/buy/browse/v1/item/get_item_by_legacy_id",
      { legacy_item_id: legacyId },
      marketplace,
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

export async function search(opts) {
  const filters = [];
  if (opts.buyingOptions?.length) filters.push(`buyingOptions:{${opts.buyingOptions.join("|")}}`);
  if (opts.minPrice != null || opts.maxPrice != null) {
    filters.push(`price:[${opts.minPrice ?? ""}..${opts.maxPrice ?? ""}]`);
    filters.push(`priceCurrency:${opts.currency || "USD"}`);
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
