// netlify/functions/market.mts
// GET  /api/market                -> { items: [...] } live state for every sword, drift-applied
// GET  /api/market?item=NAME       -> { item, history: [...] } one sword + its full permanent log
// POST /api/market                 -> dev-only edit (requires x-dev-code header)

import type { Context, Config } from "@netlify/functions";
import {
  marketStore, historyStore, isDevRequest, jsonResponse,
  defaultMarketItem, applyDrift, backfillHistory, toHistoryPoint,
  type MarketItem, type Tier, type HistoryPoint, TIER_ORDER,
} from "./_shared.mts";

const MARKET_KEY = "all-items";
const MAX_HISTORY_POINTS = 20000;

async function loadMarket(): Promise<Record<string, MarketItem>> {
  const store = marketStore();
  const data = await store.get(MARKET_KEY, { type: "json" }) as Record<string, MarketItem> | null;
  return data || {};
}

async function saveMarket(market: Record<string, MarketItem>): Promise<void> {
  await marketStore().setJSON(MARKET_KEY, market);
}

async function appendHistory(name: string, points: HistoryPoint[]): Promise<void> {
  if (points.length === 0) return;
  const store = historyStore();
  const key = "item:" + name;
  const existing = await store.get(key, { type: "json" }) as HistoryPoint[] | null;
  const list = existing || [];
  list.push(...points);
  // Cap so a single blob never grows unbounded; oldest points drop first —
  // should essentially never trigger under normal use.
  if (list.length > MAX_HISTORY_POINTS) list.splice(0, list.length - MAX_HISTORY_POINTS);
  await store.setJSON(key, list);
}

async function getHistory(name: string): Promise<HistoryPoint[]> {
  const store = historyStore();
  const data = await store.get("item:" + name, { type: "json" }) as HistoryPoint[] | null;
  return data || [];
}

/**
 * Ensures the given item exists in the market map (backfilling a rich
 * multi-year synthetic history if this is the first time it's ever been
 * requested), applies time-based drift, and returns any new history points
 * that need to be persisted alongside the item.
 */
async function getLiveItem(
  market: Record<string, MarketItem>,
  name: string,
  image: string | undefined,
  now: number
): Promise<{ item: MarketItem; dirty: boolean; newPoints: HistoryPoint[] }> {
  let item = market[name];
  if (!item) {
    item = defaultMarketItem(name, image || "");
    market[name] = item;
    const newPoints = backfillHistory(item, now);
    return { item, dirty: true, newPoints };
  }
  const newPoints = applyDrift(item, now);
  return { item, dirty: newPoints.length > 0, newPoints };
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const now = Date.now();

  if (req.method === "GET") {
    const itemName = url.searchParams.get("item");
    const market = await loadMarket();

    if (itemName) {
      const { item, dirty, newPoints } = await getLiveItem(market, itemName, undefined, now);
      if (dirty) {
        await saveMarket(market);
        await appendHistory(itemName, newPoints);
      }
      const history = await getHistory(itemName);
      return jsonResponse({ item, history });
    }

    // Bulk listing: apply drift to every known item. Doing this on every
    // request keeps things simple and correct; Blobs reads/writes are cheap
    // enough for a catalog this size.
    let anyDirty = false;
    const historyWrites: Record<string, HistoryPoint[]> = {};
    for (const name of Object.keys(market)) {
      const { dirty, newPoints } = await getLiveItem(market, name, undefined, now);
      if (dirty) {
        anyDirty = true;
        historyWrites[name] = newPoints;
      }
    }
    if (anyDirty) {
      await saveMarket(market);
      for (const [name, points] of Object.entries(historyWrites)) {
        await appendHistory(name, points);
      }
    }
    return jsonResponse({ items: Object.values(market) });
  }

  if (req.method === "POST") {
    if (!isDevRequest(req)) {
      return jsonResponse({ error: "Invalid developer code." }, { status: 403 });
    }
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
    }

    const action = body.action;
    const market = await loadMarket();

    if (action === "seed") {
      // Bulk-create/update base catalog entries (name + image), used once
      // by the front-end on first load to populate all 526 swords.
      const entries: { name: string; image: string }[] = body.entries || [];
      for (const { name, image } of entries) {
        if (!market[name]) {
          const item = defaultMarketItem(name, image);
          market[name] = item;
          const points = backfillHistory(item, now);
          await appendHistory(name, points);
        } else if (image && !market[name].image) {
          market[name].image = image;
        }
      }
      await saveMarket(market);
      return jsonResponse({ ok: true, count: entries.length });
    }

    if (action === "edit") {
      const name: string = body.name;
      if (!name || !market[name]) {
        return jsonResponse({ error: "Unknown item." }, { status: 404 });
      }
      const item = market[name];
      const patch = body.patch || {};

      if (patch.tier && TIER_ORDER.includes(patch.tier as Tier)) item.tier = patch.tier;
      if (typeof patch.value === "number") item.value = Math.max(1, Math.round(patch.value));
      if (typeof patch.stock === "number") item.stock = Math.max(1, Math.round(patch.stock));
      if (typeof patch.deletedCopies === "number") {
        item.deletedCopies = Math.max(0, Math.min(item.stock - 1, Math.round(patch.deletedCopies)));
      }
      if (typeof patch.owners === "number") item.owners = Math.max(1, Math.round(patch.owners));
      if (typeof patch.premiumCopies === "number") item.premiumCopies = Math.max(0, Math.round(patch.premiumCopies));
      if (typeof patch.premiumOwners === "number") item.premiumOwners = Math.max(0, Math.round(patch.premiumOwners));
      if (typeof patch.hoardedCopies === "number") item.hoardedCopies = Math.max(0, Math.round(patch.hoardedCopies));
      if (typeof patch.image === "string" && patch.image) item.image = patch.image;
      if (typeof patch.valueItem === "boolean") item.valueItem = patch.valueItem;

      // Custom tank/rise: dev supplies an absolute target price and a
      // duration (in hours) to reach it. Starting a new trend leg resets
      // the anchor so the curve ramps from "right now," not from wherever
      // the old leg happened to be.
      if (patch.trend && (patch.trend.state === "stable" || patch.trend.state === "rising" || patch.trend.state === "tanking")) {
        const state = patch.trend.state;
        if (state === "stable") {
          const target = typeof patch.trend.target === "number" ? Math.max(1, Math.round(patch.trend.target)) : item.rap;
          item.trend = { state: "stable", target, legStart: now, legStartRap: target, etaHours: 0 };
          item.rap = target;
          item.prevRap = target;
        } else {
          const target = typeof patch.trend.target === "number"
            ? Math.max(1, Math.round(patch.trend.target))
            : Math.round(item.rap * (state === "rising" ? 1.6 : 0.4));
          const etaHours = typeof patch.trend.etaHours === "number" && patch.trend.etaHours > 0
            ? patch.trend.etaHours
            : (patch.trend.speed === "fast" ? 7 * 24 : 30 * 24); // legacy slow/fast fallback
          item.trend = { state, target, legStart: now, legStartRap: item.rap, etaHours };
        }
      }
      if (typeof patch.rap === "number") {
        item.rap = Math.max(1, Math.round(patch.rap));
        item.prevRap = item.rap;
      }

      item.lastUpdated = now;
      await saveMarket(market);
      await appendHistory(name, [toHistoryPoint(item, now, 0)]);
      return jsonResponse({ ok: true, item });
    }

    if (action === "reset") {
      const name: string = body.name;
      if (name && market[name]) {
        delete market[name];
        await saveMarket(market);
      }
      return jsonResponse({ ok: true });
    }

    if (action === "add") {
      const name: string = body.name;
      if (!name || market[name]) {
        return jsonResponse({ error: "Missing name or item already exists." }, { status: 400 });
      }
      const item = defaultMarketItem(name, body.image || "");
      if (body.tier && TIER_ORDER.includes(body.tier)) item.tier = body.tier;
      if (typeof body.stock === "number") item.stock = Math.max(1, Math.round(body.stock));
      if (typeof body.valueItem === "boolean") item.valueItem = body.valueItem;
      if (typeof body.value === "number") {
        item.value = Math.max(1, Math.round(body.value));
        // RAP defaults to the given value unless a separate RAP was supplied.
        item.rap = item.value;
        item.prevRap = item.value;
        item.trend.target = item.value;
        item.trend.legStartRap = item.value;
      }
      if (typeof body.rap === "number") {
        item.rap = Math.max(1, Math.round(body.rap));
        item.prevRap = item.rap;
        item.trend.target = item.rap;
        item.trend.legStartRap = item.rap;
      }
      item.custom = true;
      market[name] = item;
      await saveMarket(market);
      await appendHistory(name, [toHistoryPoint(item, now, 0)]);
      return jsonResponse({ ok: true, item });
    }

    return jsonResponse({ error: "Unknown action." }, { status: 400 });
  }

  return jsonResponse({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: "/api/market",
};
