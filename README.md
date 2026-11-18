# eBay MCP

MCP server for searching and checking eBay listings — auctions (bids) and Buy It Now.
Uses the eBay Browse API with an app token (no user login needed).

## Setup
1. Create keys at https://developer.ebay.com (Application Keys → Production).
2. `npm install`
3. Add to your MCP client, e.g. Claude Code:
   ```
   claude mcp add ebay -e EBAY_CLIENT_ID=... -e EBAY_CLIENT_SECRET=... -- node /home/rshazow/Projects/Ebay-MCP/src/index.js
   ```

Optional env: `EBAY_MARKETPLACE_ID` — `EUROPE` (searches DE, GB, FR, IT, ES, NL, BE, AT, IE, CH, PL at once), one site like `EBAY_DE`, or a comma list. Default `EBAY_US`. Also `EBAY_ENV=sandbox`.

`EBAY_SHIP_TO` — your country code (e.g. `PT`). Searches then only return items that ship there and quote shipping to it. Optional `EBAY_SHIP_ZIP` for more exact quotes.

## Tools
| Tool | What it does |
|---|---|
| `search_listings` | Search all listings. Filter: type (auction / buy_it_now / best_offer), price, condition, seller, sort. |
| `search_auctions` | Live auctions, ending soonest. Optional `endingWithinHours`. |
| `get_listing` | Full details from a URL, item number, or `v1|…|0` id. |
| `check_listings` | Check up to 50 items: current bid, bid count, min next bid, reserve, time left. Shows changes since the last check and flags items over `maxPrice`. |

## Limits
- Read-only. Placing bids needs eBay's restricted Offer API and user OAuth — not included.
- Change tracking is in memory; it resets when the server restarts.
