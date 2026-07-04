// netlify/functions/inventory.mts
// GET  /api/inventory  -> { wallet, tokens, crystals, items: {name: qty} } for the signed-in user
// POST /api/inventory  -> { action: "setBalance"|"adjustBalance"|"setItemQty", currency, ... }

import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { resolveSession, jsonResponse } from "./_shared.mts";

type Currency = "cash" | "token" | "crystal";
const CURRENCY_FIELD: Record<Currency, "wallet" | "tokens" | "crystals"> = {
  cash: "wallet",
  token: "tokens",
  crystal: "crystals",
};

interface InventoryRecord {
  wallet: number;   // cash ($)
  tokens: number;   // yellow currency
  crystals: number; // purple currency
  items: Record<string, number>;
}

function inventoryStore() {
  return getStore("bb-inventory");
}

async function loadInventory(username: string): Promise<InventoryRecord> {
  const store = inventoryStore();
  const data = await store.get(username, { type: "json" }) as Partial<InventoryRecord> | null;
  return {
    wallet: data?.wallet ?? 5400,
    tokens: data?.tokens ?? 0,
    crystals: data?.crystals ?? 0,
    items: data?.items ?? {},
  };
}

async function saveInventory(username: string, inv: InventoryRecord): Promise<void> {
  await inventoryStore().setJSON(username, inv);
}

function parseCurrency(raw: unknown): Currency {
  return raw === "token" ? "token" : raw === "crystal" ? "crystal" : "cash";
}

export default async (req: Request, _context: Context) => {
  const username = await resolveSession(req);
  if (!username) {
    return jsonResponse({ error: "Not signed in." }, { status: 401 });
  }

  if (req.method === "GET") {
    const inv = await loadInventory(username);
    return jsonResponse({ ok: true, ...inv });
  }

  if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, { status: 400 });
    }
    const inv = await loadInventory(username);

    if (body.action === "setBalance") {
      const currency = parseCurrency(body.currency);
      const field = CURRENCY_FIELD[currency];
      const amount = Math.max(0, Math.round(Number(body.amount) || 0));
      inv[field] = amount;
    } else if (body.action === "adjustBalance") {
      const currency = parseCurrency(body.currency);
      const field = CURRENCY_FIELD[currency];
      const amount = Math.round(Number(body.amount) || 0);
      const sign = body.mode === "subtract" ? -1 : 1;
      inv[field] = Math.max(0, inv[field] + sign * Math.abs(amount));
    } else if (body.action === "setItemQty") {
      const name: string = body.name;
      const qty = Math.max(0, Math.round(Number(body.qty) || 0));
      if (!name) return jsonResponse({ error: "Missing item name." }, { status: 400 });
      if (qty === 0) {
        delete inv.items[name];
      } else {
        inv.items[name] = qty;
      }
    } else {
      return jsonResponse({ error: "Unknown action." }, { status: 400 });
    }

    await saveInventory(username, inv);
    return jsonResponse({ ok: true, ...inv });
  }

  return jsonResponse({ error: "Method not allowed." }, { status: 405 });
};

export const config: Config = {
  path: "/api/inventory",
};
