// netlify/functions/_shared.mts
// Shared utilities used by every function: storage access, auth, and the
// time-based market drift engine. Not itself a function (no default export),
// so Netlify won't route to it directly.

import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const DEV_CODE = "Kiki";

// ---------------------------------------------------------------------------
// Blob stores
// ---------------------------------------------------------------------------
export function marketStore() {
  return getStore("bb-market");
}
export function historyStore() {
  return getStore("bb-history");
}
export function usersStore() {
  return getStore("bb-users");
}
export function sessionsStore() {
  return getStore("bb-sessions");
}

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Sessions (random opaque token -> username, stored in Blobs with expiry)
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(username: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  const store = sessionsStore();
  await store.setJSON(token, {
    username,
    expires: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

export async function resolveSession(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const store = sessionsStore();
  const data = await store.get(token, { type: "json" }) as
    | { username: string; expires: number }
    | null;
  if (!data) return null;
  if (data.expires < Date.now()) {
    await store.delete(token);
    return null;
  }
  return data.username;
}

export async function destroySession(req: Request): Promise<void> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return;
  await sessionsStore().delete(token);
}

// ---------------------------------------------------------------------------
// Dev-mode auth: the client sends the 4-char code in a header. This is a
// convenience gate matching the front-end's existing "Kiki" flow, not a
// real security boundary — treat this deployment as trusted-friends-only.
// ---------------------------------------------------------------------------
export function isDevRequest(req: Request): boolean {
  return req.headers.get("x-dev-code") === DEV_CODE;
}

// ---------------------------------------------------------------------------
// Deterministic per-item hashing (mirrors the front-end's rarity/value model
// so a freshly-seen item gets sensible defaults before it's ever drifted).
// ---------------------------------------------------------------------------
export function hashString(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h >>> 0);
}

export type Tier =
  | "mystery"
  | "event"
  | "mythical"
  | "legendary"
  | "epic"
  | "rare"
  | "uncommon"
  | "common";

export const TIER_ORDER: Tier[] = [
  "mystery", "event", "mythical", "legendary", "epic", "rare", "uncommon", "common",
];

export const STOCK_RANGES: Record<Tier, [number, number]> = {
  mystery: [1, 6],
  event: [1, 35],
  mythical: [36, 150],
  legendary: [151, 500],
  epic: [501, 2500],
  rare: [2501, 10000],
  uncommon: [10001, 40000],
  common: [40001, 150000],
};

export const VALUE_RANGES: Record<Tier, [number, number]> = {
  mystery: [750_000_000_000, 1_050_000_000_000],
  common: [80_000, 150_000],
  uncommon: [250_000, 900_000],
  rare: [1_500_000, 6_000_000],
  epic: [10_000_000, 45_000_000],
  legendary: [75_000_000, 350_000_000],
  mythical: [600_000_000, 4_000_000_000],
  event: [6_000_000_000, 220_000_000_000],
};

const DELETION_RATE_RANGE: Record<Tier, [number, number]> = {
  mystery: [0.005, 0.03], event: [0.005, 0.03], mythical: [0.02, 0.08],
  legendary: [0.05, 0.15], epic: [0.10, 0.25], rare: [0.15, 0.35],
  uncommon: [0.25, 0.50], common: [0.35, 0.65],
};
const HOARD_RATE_RANGE: Record<Tier, [number, number]> = {
  mystery: [0.08, 0.20], event: [0.08, 0.20], mythical: [0.06, 0.15],
  legendary: [0.04, 0.10], epic: [0.03, 0.08], rare: [0.02, 0.06],
  uncommon: [0.01, 0.04], common: [0.005, 0.02],
};
const PREMIUM_RATE_RANGE: [number, number] = [0.15, 0.45];

function hashFrac(str: string): number {
  return (hashString(str) % 1000) / 1000;
}

export interface MarketItem {
  name: string;
  tier: Tier;
  stock: number;
  value: number;      // base/original value (dev-set anchor, used for default trend targets)
  rap: number;         // current live price (last simulated sale, or trend-curve estimate)
  prevRap: number;      // kept for backward-compat display only; trend math uses trend.legStartRap
  trend: {
    state: "stable" | "rising" | "tanking";
    target: number;      // absolute price this item is drifting toward
    legStart: number;      // epoch ms when this trend leg began
    legStartRap: number;   // price at the moment this trend leg began
    etaHours: number;      // hours to close ~95% of the gap to target (0/ignored when stable)
  };
  valueItem: boolean;   // hype flag: sale prices skew upward (overpaid), independent of tier
  deletedCopies: number;
  owners: number;
  premiumCopies: number;
  premiumOwners: number;
  hoardedCopies: number;
  lastUpdated: number; // epoch ms
  custom: boolean;
  image: string;
}

export function defaultMarketItem(name: string, image = ""): MarketItem {
  const tier = getRarityTier(name);
  const stock = computeStock(name, tier);
  const value = computeValue(name, tier, stock);
  const own = computeOwnership(name, tier, stock);
  const now = Date.now();
  return {
    name, tier, stock, value, rap: value, prevRap: value,
    trend: { state: "stable", target: value, legStart: now, legStartRap: value, etaHours: 0 },
    valueItem: false,
    ...own,
    lastUpdated: now,
    custom: false,
    image,
  };
}

const EVENT_WORDS = ["krampus","festive","santa","snowball","candycane","ornament","jolly",
  "christmas","valentine","cupid","easter","bunny","halloween","pumpkin","skeleton","mummy",
  "vampire","coffin","ghost","witch","noob","floppy chicken","kitty launcher","cat paw","shark",
  "t-rex","wicked crow","fallen angel","requiem","aurora bow","love","heart"];
const MYTHICAL_WORDS = ["divine","heavenly","holy","seraphim","eternal","infinite","astral",
  "celestial","nebula","singularity","blackhole","cosmic","stellar","galaxy","void","empyrean",
  "resurrection","eclipse","abyssal","demonic","monarch","sovereign","calamity","oblivion",
  "final phase","hollow oath","dreadborn","draconic","kraken","leviathan","dragon slayer",
  "stormbane","aurelius","angel","devil"];
const LEGENDARY_WORDS = ["king","queen","prince","princess","royal","crystal","lightning",
  "frigid","frost","inferno","storm","thunder","crimson","prismatic","aetherial","stardust",
  "starlight","moonlight","moonbeam","moonflower","phantom","obsidian","vaporwave","hakai",
  "cursed","soulrender","malice","zodiac","permafrost","samurai","dragon","phoenix","divinity",
  "spinalis","valkyrien","oni","seraph","kingsguard"];

function baseName(name: string): string {
  return name.replace(/^Dual\s+/i, "").trim().toLowerCase();
}

export function getRarityTier(name: string): Tier {
  const base = baseName(name);
  if (EVENT_WORDS.some(w => base.includes(w))) return "event";
  if (MYTHICAL_WORDS.some(w => base.includes(w))) return "mythical";
  if (LEGENDARY_WORDS.some(w => base.includes(w))) return "legendary";
  const h = hashString(base) % 100;
  if (h < 10) return "epic";
  if (h < 30) return "rare";
  if (h < 60) return "uncommon";
  return "common";
}

export function computeStock(name: string, tier: Tier): number {
  const base = baseName(name);
  const [min, max] = STOCK_RANGES[tier];
  const h2 = hashString(base + "::stock");
  let stock = min + (h2 % (max - min + 1));
  if (/^dual\s+/i.test(name.trim())) {
    stock = Math.max(1, Math.round(stock / 2.4));
  }
  return stock;
}

export function computeValue(name: string, tier: Tier, stock: number): number {
  const [smin, smax] = STOCK_RANGES[tier];
  const [vmin, vmax] = VALUE_RANGES[tier];
  let frac = (stock - smin) / (smax - smin);
  frac = Math.min(1, Math.max(0, frac));
  let value = vmax - frac * (vmax - vmin);
  const jitter = 0.92 + (hashString(baseName(name) + "::value") % 17) / 100;
  value = Math.round((value * jitter) / 100) * 100;
  return Math.max(vmin, Math.min(vmax, value));
}

function computeOwnership(name: string, tier: Tier, stock: number) {
  const delRange = DELETION_RATE_RANGE[tier];
  const deletionRate = delRange[0] + hashFrac(name + "::del") * (delRange[1] - delRange[0]);
  const deletedCopies = Math.min(Math.max(0, stock - 1), Math.round(stock * deletionRate));
  const availableCopies = Math.max(1, stock - deletedCopies);

  const hoardRange = HOARD_RATE_RANGE[tier];
  const hoardRate = hoardRange[0] + hashFrac(name + "::hoard") * (hoardRange[1] - hoardRange[0]);
  const hoardedCopies = Math.min(Math.max(0, availableCopies - 1), Math.round(availableCopies * hoardRate));
  const avgHoardSize = 2.5 + hashFrac(name + "::hoardsize") * 3.5;
  const hoarderCount = hoardedCopies > 0 ? Math.max(1, Math.round(hoardedCopies / avgHoardSize)) : 0;
  const nonHoarded = Math.max(0, availableCopies - hoardedCopies);
  const owners = Math.max(1, nonHoarded + hoarderCount);

  const premiumRate = PREMIUM_RATE_RANGE[0] + hashFrac(name + "::prem") * (PREMIUM_RATE_RANGE[1] - PREMIUM_RATE_RANGE[0]);
  const premiumCopies = Math.max(0, Math.round(availableCopies * premiumRate));
  const premiumOwnersRaw = Math.round(owners * premiumRate * (0.85 + hashFrac(name + "::premown") * 0.2));
  const premiumOwners = Math.max(0, Math.min(premiumOwnersRaw, owners));

  return { deletedCopies, owners, premiumCopies, premiumOwners, hoardedCopies };
}

// ---------------------------------------------------------------------------
// Time-based drift engine
//
// The market doesn't move on a smooth curve — it moves because (simulated)
// people buy and sell. Rarer/pricier items trade rarely (sometimes zero
// sales for a long stretch), so their charts stay flat with occasional
// sharp jumps. Common items trade constantly, so their charts stay noisy
// and dense. A trend (rising/tanking) doesn't force the price up or down
// every tick — it just biases where each random sale lands, pulling the
// underlying "fair value" curve toward a dev-set target over a dev-set
// duration, while every individual sale still jitters around that curve.
// ---------------------------------------------------------------------------

const MIN_DRIFT_INTERVAL_MS = 5 * 60 * 1000; // don't drift more than once per 5 min per item

// Expected sales per day, tier-scaled. Common blades trade dozens of times a
// day; mystery/event tier is genuinely illiquid — realistically 1 to 3+
// *years* between sales, same as a real one-of-a-kind collectible.
const SALE_RATE_PER_DAY: Record<Tier, [number, number]> = {
  mystery: [0.0008, 0.0028],   // ~1 sale every 1-3.4 years
  event: [0.0015, 0.006],       // ~1 sale every 5.5 months - 1.8 years
  mythical: [0.02, 0.12],        // ~1 sale every 8-50 days
  legendary: [0.15, 0.6],          // ~1 sale every 1.5-6.5 days
  epic: [0.8, 3],                    // roughly daily
  rare: [4, 12],                       // several times a day
  uncommon: [15, 45],
  common: [45, 130],
};

// Per-sale price swing as a fraction of the underlying trend-curve value —
// rarer items swing harder per trade since there's less liquidity.
const VOLATILITY_RANGE: Record<Tier, [number, number]> = {
  mystery: [0.18, 0.35], event: [0.15, 0.30], mythical: [0.10, 0.22],
  legendary: [0.08, 0.16], epic: [0.06, 0.12], rare: [0.05, 0.10],
  uncommon: [0.03, 0.07], common: [0.02, 0.05],
};

const MAX_EVENTS_PER_DRIFT_CALL = 40;
const MAX_EVENTS_BACKFILL = 1400;
const BACKFILL_YEARS = 4.25;

export interface HistoryPoint {
  t: number;      // epoch ms
  price: number;
  volume: number;
  deletedCopies: number;
  owners: number;
  premiumCopies: number;
  premiumOwners: number;
  hoardedCopies: number;
}

function pickInRange(range: [number, number]): number {
  return range[0] + Math.random() * (range[1] - range[0]);
}

/** Exponential approach from legStartRap toward target; ~95% closed by etaHours. */
function trendCurveValue(trend: MarketItem["trend"], hoursSinceLegStart: number): number {
  if (trend.state === "stable" || trend.etaHours <= 0) return trend.target;
  const k = 3 / trend.etaHours;
  const span = trend.target - trend.legStartRap;
  const progress = 1 - Math.exp(-k * Math.max(0, hoursSinceLegStart));
  return Math.max(1, trend.legStartRap + span * progress);
}

function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Proper Poisson sample — critical for rare tiers: with tiny per-check
 * expected values (e.g. a mystery item checked daily has ~0.002 expected
 * sales that day), naive rounding always yields 0 and probability mass
 * never accumulates, so the item could go LITERALLY forever without a
 * sale even over real years of check-ins. A real Poisson sampler keeps the
 * small per-check chance genuine, so it still correctly averages out to
 * "about one sale every year or so" across many checks, matching reality.
 */
function poissonSample(lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) {
    // Normal approximation for large lambda — avoids the slow/underflow-prone
    // exact method, which would otherwise need hundreds of multiplications.
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gaussianRandom()));
  }
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

interface SimEvent { hoursIntoLeg: number; price: number; volume: number }

/**
 * Simulates however many random sales would plausibly happen for this item
 * between hoursFrom and hoursTo (both measured as hours-since-trend-leg-start),
 * each one jittered around the trend curve at its own moment in time.
 */
function simulateSales(
  tier: Tier, trend: MarketItem["trend"], valueItem: boolean,
  hoursFrom: number, hoursTo: number, maxEvents: number
): SimEvent[] {
  const windowHours = Math.max(0, hoursTo - hoursFrom);
  if (windowHours <= 0) return [];

  const saleRate = pickInRange(SALE_RATE_PER_DAY[tier]);
  const vol = pickInRange(VOLATILITY_RANGE[tier]);
  const expected = (windowHours / 24) * saleRate;
  const count = Math.max(0, Math.min(maxEvents, poissonSample(expected)));

  const hours: number[] = [];
  for (let i = 0; i < count; i++) hours.push(hoursFrom + Math.random() * windowHours);
  hours.sort((a, b) => a - b);

  return hours.map((hoursIntoLeg) => {
    const base = trendCurveValue(trend, hoursIntoLeg);
    let noiseFactor = 1 + (Math.random() * 2 - 1) * vol;
    if (Math.random() < 0.08) {
      // Occasional bigger spike/dip so the chart isn't uniformly jittery —
      // matches the "diverse" spiky look of real trade history.
      noiseFactor *= 1 + (Math.random() * 2 - 1) * vol * 2.5;
    }
    if (valueItem) {
      // Hype/overpay skew: value items sell for more than their "fair" curve
      // suggests, consistently, not just occasionally.
      noiseFactor *= 1 + Math.random() * 0.18;
    }
    const price = Math.max(1, Math.round(base * noiseFactor));
    const volume = 1 + Math.floor(Math.random() * 3);
    return { hoursIntoLeg, price, volume };
  });
}

function snapshotOwnership(item: MarketItem) {
  return {
    deletedCopies: item.deletedCopies,
    owners: item.owners,
    premiumCopies: item.premiumCopies,
    premiumOwners: item.premiumOwners,
    hoardedCopies: item.hoardedCopies,
  };
}

/** Ages ownership numbers forward by elapsedHours (deletions up, owners down, both capped). */
function ageOwnership(item: MarketItem, elapsedHours: number): void {
  const [dmin] = DELETION_RATE_RANGE[item.tier];
  const deletionTick = Math.min(
    Math.max(0, item.stock - 1 - item.deletedCopies),
    Math.round(item.stock * dmin * Math.min(elapsedHours / 720, 1) * Math.random())
  );
  item.deletedCopies = Math.min(item.stock - 1, item.deletedCopies + deletionTick);
  const availableCopies = Math.max(1, item.stock - item.deletedCopies);
  const ownerDrift = Math.round(item.owners * Math.min(elapsedHours / 2000, 0.03) * Math.random());
  item.owners = Math.max(1, Math.min(availableCopies, item.owners - ownerDrift));
  item.premiumCopies = Math.min(availableCopies, item.premiumCopies);
  item.premiumOwners = Math.min(item.owners, item.premiumOwners);
  item.hoardedCopies = Math.min(availableCopies, item.hoardedCopies);
}

/**
 * Given an item's stored state, simulates whatever sales would plausibly
 * have happened since it was last checked, mutating the item's live price
 * and ownership numbers in place, and returns the new permanent history
 * points to append (may be empty only if the elapsed time was too short to
 * bother drifting at all).
 */
export function applyDrift(item: MarketItem, now: number): HistoryPoint[] {
  const elapsedMs = now - item.lastUpdated;
  if (elapsedMs < MIN_DRIFT_INTERVAL_MS) return [];

  const hoursFrom = (item.lastUpdated - item.trend.legStart) / 3_600_000;
  const hoursTo = (now - item.trend.legStart) / 3_600_000;

  const events = simulateSales(item.tier, item.trend, item.valueItem, hoursFrom, hoursTo, MAX_EVENTS_PER_DRIFT_CALL);

  ageOwnership(item, elapsedMs / 3_600_000);

  const points: HistoryPoint[] = [];
  for (const ev of events) {
    item.rap = ev.price;
    const t = Math.round(item.trend.legStart + ev.hoursIntoLeg * 3_600_000);
    points.push({ t, price: ev.price, volume: ev.volume, ...snapshotOwnership(item) });
  }
  if (events.length === 0) {
    // No simulated sale, but the market's fair-value estimate still ticks
    // along the trend curve — this is what keeps rare items' RAP moving
    // even when "little to no sale" happens, matching real illiquid markets.
    item.rap = Math.max(1, Math.round(trendCurveValue(item.trend, hoursTo)));
  }
  points.push({ t: now, price: Math.round(item.rap), volume: 0, ...snapshotOwnership(item) });

  // Once a trend leg has run its full course, settle at the target instead
  // of drifting past it forever — "hits the bottom" and stays there until
  // the dev sets a new trend.
  if (item.trend.state !== "stable" && hoursTo >= item.trend.etaHours) {
    item.rap = Math.round(item.trend.target);
    item.trend = { state: "stable", target: item.rap, legStart: now, legStartRap: item.rap, etaHours: 0 };
  }

  item.prevRap = item.rap;
  item.lastUpdated = now;
  return points;
}

/**
 * Generates a rich, multi-year synthetic trade history for a brand-new item
 * so its chart looks full immediately instead of starting from a single
 * dot. Uses the exact same random-sale-event simulator as live drift, just
 * run once over a multi-year span. After this, the item's trend is reset to
 * "stable" anchored at wherever the backfill ended up, and live drift takes
 * over from there.
 */
export function backfillHistory(item: MarketItem, now: number): HistoryPoint[] {
  const spanHours = BACKFILL_YEARS * 365 * 24;
  const legStart = now - spanHours * 3_600_000;
  item.trend = { state: "stable", target: item.value, legStart, legStartRap: item.value, etaHours: 0 };

  const events = simulateSales(item.tier, item.trend, item.valueItem, 0, spanHours, MAX_EVENTS_BACKFILL);
  const points: HistoryPoint[] = events.map((ev) => ({
    t: Math.round(legStart + ev.hoursIntoLeg * 3_600_000),
    price: ev.price,
    volume: ev.volume,
    ...snapshotOwnership(item),
  }));

  if (points.length > 0) {
    item.rap = points[points.length - 1].price;
  }
  points.push({ t: now, price: Math.round(item.rap), volume: 0, ...snapshotOwnership(item) });

  item.trend = { state: "stable", target: item.rap, legStart: now, legStartRap: item.rap, etaHours: 0 };
  item.prevRap = item.rap;
  item.lastUpdated = now;
  return points;
}

export function toHistoryPoint(item: MarketItem, now: number, volume: number): HistoryPoint {
  return { t: now, price: Math.round(item.rap), volume, ...snapshotOwnership(item) };
}

export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}
