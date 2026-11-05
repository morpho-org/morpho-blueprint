import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

const VAULT = "0x0000000000000000000000000000000000000001";
const USDC = getAddress("0x00000000000000000000000000000000000000c1");
const BASE = `/v0/vaults-v2/1:${VAULT}`;
const PRICES = `/v0/blueprint-app-api/token-prices/1:${USDC}/history`;

// The summary read is covered by vault-v2-details; here it only supplies the asset to price.
vi.mock("@/modules/vault/data/getVaultSummaries", () => ({
  getVaultV2Summary: async () => ({
    summary: { asset: { address: USDC, decimals: 6, priceUsd: 1 }, chain: { id: 1, name: "Ethereum" } },
    root: { curator: null, performance_fee_wad: null, management_fee_wad: null },
    state: { idle_assets: "0" },
  }),
}));
vi.mock("@/modules/reward/data/getMerklRewardIndex", () => ({ getMerklRewardIndex: async () => ({}) }));
vi.mock("@/modules/vault/data/getVaultV2Details", () => ({ getVaultV2Details: async () => ({}) }));
vi.mock("@/modules/vault/data/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/vault/data/adapters")>()),
  toMorphoVaultV2Details: () => ({}),
}));
vi.mock("@/modules/vault/utils/normalizeVault", () => ({ normalizeVault: <T>(vault: T) => vault }));

const blueprint = { enabled: true };
vi.mock("@/common/utils/morphoApiConfig", () => ({ isBlueprintApiEnabled: () => blueprint.enabled }));

interface PriceRoute {
  points: { timestamp: number; price_usd: number | null }[];
  requestTime?: { timestamp: number; price_usd: number | null };
}

const routes = new Map<string, unknown>();
const priceRoutes = new Map<string, PriceRoute>();
const failing = new Set<string>();
const calls: { path: string; query: Record<string, unknown>; options: unknown }[] = [];
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string, query: Record<string, unknown>, options?: unknown) => {
    calls.push({ path, query, options });
    if (failing.has(path)) throw new Error("upstream down");
    if (path !== PRICES) return routes.get(`${path}?${query.lookback}`) ?? null;
    const body = priceRoutes.get(`${query.interval}`);
    if (!body) return null;
    // Like the route: the request-time price comes only when the end reaches the route's clock,
    // here one second ahead of the app's.
    const routeNow = Math.floor(Date.now() / 1000) + 1;
    const end = query.end_timestamp === undefined ? routeNow : Number(query.end_timestamp);
    const { points, requestTime } = body;
    return { data: { points: end >= routeNow && requestTime ? [...points, requestTime] : points } };
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
}));

async function loadHistory() {
  const { getVault } = await import("@/modules/vault/data/getVault");
  const vault = await getVault(1, VAULT, Erc4626VaultProtocol.MorphoV2);
  return vault.historical;
}

function seedHourly() {
  routes.set(`${BASE}/state/history?seven_days`, {
    data: [
      { timestamp: 3600, total_assets: "1500000" },
      { timestamp: 7200, total_assets: "2000000" },
      // Core appends a request-time point off the hourly grid.
      { timestamp: 7300, total_assets: "2100000" },
    ],
  });
  routes.set(`${BASE}/apy/history?seven_days`, {
    data: [
      { timestamp: 3600, apy: 0.04 },
      { timestamp: 7200, apy: 0.05 },
    ],
  });
}

describe("getVault (Vault V2 history)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes.clear();
    priceRoutes.clear();
    failing.clear();
    calls.length = 0;
    blueprint.enabled = true;
  });

  it("reads state and APY history from Core REST, one lookback per chart resolution", async () => {
    await loadHistory();

    const historyCalls = calls.filter(({ path }) => path.startsWith(BASE));
    expect(historyCalls.map(({ path, query }) => `${path.replace(BASE, "")} ${JSON.stringify(query)}`).sort()).toEqual([
      '/apy/history {"lookback":"inception"}',
      '/apy/history {"lookback":"ninety_days"}',
      '/apy/history {"lookback":"seven_days"}',
      '/state/history {"lookback":"inception"}',
      '/state/history {"lookback":"ninety_days"}',
      '/state/history {"lookback":"seven_days"}',
    ]);
  });

  it("prices total assets from the Blueprint price history, nearest sample within one interval", async () => {
    seedHourly();
    priceRoutes.set("hour", {
      points: [
        { timestamp: 3600, price_usd: 2 },
        { timestamp: 7200, price_usd: null },
      ],
    });

    const historical = await loadHistory();

    const priceCall = calls.find(({ path, query }) => path === PRICES && query.interval === "hour");
    // No end: the route defaults to its own now, so its request-time price is never dropped.
    expect(priceCall?.query).toEqual({ start_timestamp: 3600, interval: "hour" });
    expect(priceCall?.options).toEqual({ api: "blueprint", quiet: true });
    expect(historical?.hourly).toEqual([
      { bucketTimestamp: 3600, totalSupplied: { formatted: "1.5", usd: 3 }, netApy: { total: 0.04 } },
      // A null price stays a gap rather than borrowing an older sample.
      { bucketTimestamp: 7200, totalSupplied: { formatted: "2", usd: null }, netApy: { total: 0.05 } },
      { bucketTimestamp: 7300, totalSupplied: { formatted: "2.1", usd: null }, netApy: { total: 0.05 } },
    ]);
  });

  it("prices Core's request-time state row with the route's request-time price", async () => {
    seedHourly();
    priceRoutes.set("hour", {
      points: [
        { timestamp: 3600, price_usd: 2 },
        { timestamp: 7200, price_usd: 1 },
      ],
      requestTime: { timestamp: 7310, price_usd: 2 },
    });

    const historical = await loadHistory();

    // The newest row takes the request-time price (2), not the last hourly top (1).
    expect(historical?.hourly.map((entry) => entry.totalSupplied.usd)).toEqual([3, 2, 4.2]);
  });

  it("keeps the state rows Core serves before the first APY sample (a vault's first day)", async () => {
    routes.set(`${BASE}/state/history?ninety_days`, {
      data: [
        { timestamp: 86_400, total_assets: "1000000" },
        { timestamp: 172_800, total_assets: "2000000" },
        { timestamp: 259_200, total_assets: "3000000" },
      ],
    });
    routes.set(`${BASE}/apy/history?ninety_days`, { data: [{ timestamp: 172_800, apy: 0.04 }] });

    const historical = await loadHistory();

    expect(historical?.daily).toEqual([
      { bucketTimestamp: 86_400, totalSupplied: { formatted: "1", usd: null }, netApy: { total: null } },
      { bucketTimestamp: 172_800, totalSupplied: { formatted: "2", usd: null }, netApy: { total: 0.04 } },
      { bucketTimestamp: 259_200, totalSupplied: { formatted: "3", usd: null }, netApy: { total: 0.04 } },
    ]);
  });

  it("leaves out-of-range APY rows as gaps and keeps their deposits rows", async () => {
    // Core serves rows like these for a Gauntlet USDT Prime vault's first days.
    routes.set(`${BASE}/state/history?inception`, {
      data: [
        { timestamp: 86_400, total_assets: "1000000" },
        { timestamp: 172_800, total_assets: "2000000" },
        { timestamp: 259_200, total_assets: "3000000" },
        { timestamp: 345_600, total_assets: "4000000" },
        { timestamp: 432_000, total_assets: "5000000" },
      ],
    });
    routes.set(`${BASE}/apy/history?inception`, {
      data: [
        { timestamp: 86_400, apy: 1.9e73 },
        { timestamp: 172_800, apy: -1 },
        { timestamp: 259_200, apy: 0.04 },
        { timestamp: 345_600, apy: 1e37 },
        { timestamp: 432_000, apy: 10 },
      ],
    });

    const historical = await loadHistory();

    expect(historical?.weekly).toEqual([
      { bucketTimestamp: 86_400, totalSupplied: { formatted: "1", usd: null }, netApy: { total: null } },
      { bucketTimestamp: 172_800, totalSupplied: { formatted: "2", usd: null }, netApy: { total: null } },
      { bucketTimestamp: 259_200, totalSupplied: { formatted: "3", usd: null }, netApy: { total: 0.04 } },
      // A gap, not the previous row's APY carried forward.
      { bucketTimestamp: 345_600, totalSupplied: { formatted: "4", usd: null }, netApy: { total: null } },
      // 1000% is the top of the kept range.
      { bucketTimestamp: 432_000, totalSupplied: { formatted: "5", usd: null }, netApy: { total: 10 } },
    ]);
  });

  it("serves no USD series and sends no price request when the Blueprint API is off", async () => {
    blueprint.enabled = false;
    seedHourly();

    const historical = await loadHistory();

    expect(calls.some(({ path }) => path === PRICES)).toBe(false);
    expect(historical?.hourly.map((entry) => entry.totalSupplied.usd)).toEqual([null, null, null]);
  });

  it("degrades to no USD series when the price read fails", async () => {
    seedHourly();
    failing.add(PRICES);

    const historical = await loadHistory();

    expect(historical?.hourly.map((entry) => entry.totalSupplied)).toEqual([
      { formatted: "1.5", usd: null },
      { formatted: "2", usd: null },
      { formatted: "2.1", usd: null },
    ]);
  });

  it("leaves a resolution empty when the vault is missing from REST", async () => {
    const historical = await loadHistory();

    expect(historical).toEqual({ hourly: [], daily: [], weekly: [] });
    expect(calls.some(({ path }) => path === PRICES)).toBe(false);
  });
});
