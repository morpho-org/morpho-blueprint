import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock("@/config", () => ({
  APP_CONFIG: { apyWindow: "6h", chainConfig: { 1: { chain: { name: "Ethereum" }, iconSlug: "eth" } } },
}));

const MARKET_A = `0x${"aa".repeat(32)}`;
const MARKET_B = `0x${"bb".repeat(32)}`;
const IDLE = `0x${"cc".repeat(32)}`;
const supported = vi.hoisted((): { ids: Record<number, string[]> } => ({ ids: {} }));
vi.mock("@/modules/market/data/getSupportedMarketIds", () => ({ getSupportedMarketIds: async () => supported.ids }));

// Core REST, served by path. A missing entry is a 404 (`null`); an `Error` is thrown. The real
// `MorphoRestError`, `chunk` and `restSelector` are kept.
const routes = new Map<string, unknown>();
const roots: unknown[] = [];
const calls: { path: string; revalidate?: number }[] = [];
vi.mock("@/common/utils/fetchMorphoRest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/common/utils/fetchMorphoRest")>()),
  fetchMorphoRestResource: async (path: string, _query: unknown, options?: { revalidate?: number }) => {
    calls.push({ path, revalidate: options?.revalidate });
    const body = routes.get(path);
    if (body instanceof Error) throw body;
    return body ?? null;
  },
  fetchAllMorphoRestPages: async (path: string, _query: unknown, options?: { revalidate?: number }) => {
    calls.push({ path, revalidate: options?.revalidate });
    return roots;
  },
}));

const merkl = vi.hoisted((): { opportunities: unknown[]; down: boolean; requests: number } => ({
  opportunities: [],
  down: false,
  requests: 0,
}));
vi.mock("@/common/utils/fetch", () => ({
  fetchJsonResponse: async () => {
    merkl.requests += 1;
    if (merkl.down) throw new Error("Fetch failed");
    return merkl.opportunities;
  },
}));
vi.mock("@/common/utils/trackEvent", () => ({ trackEvent: async () => {} }));

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599";
const ZERO = "0x0000000000000000000000000000000000000000";
const MORPHO_TOKEN = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";

const root = (market_id: string, collateral_token: string) => ({
  chain_id: 1,
  market_id,
  loan_token: USDC,
  collateral_token,
  lltv_wad: "860000000000000000",
});
const token = (address: string, symbol: string, decimals: number) => ({
  data: { address, name: symbol, symbol, decimals, logo_uri: null, tags: [] },
});
const market = (id: string, borrowAssets: string, averages: Record<string, number | null>) => {
  routes.set(`/v0/blue/markets/1:${id}/state`, { data: { total_borrow_assets: borrowAssets } });
  routes.set(`/v0/blue/markets/1:${id}/apy-averages`, {
    data: { supply_apy_averages: {}, borrow_apy_averages: averages },
  });
};
const NOW = Math.floor(Date.now() / 1000);
const borrowCampaign = (overrides: Record<string, unknown>, params: Record<string, unknown>) => ({
  id: String(Math.random()),
  type: "MORPHOBORROW",
  subType: 0,
  computeChainId: 1,
  startTimestamp: NOW - 86_400,
  endTimestamp: NOW + 86_400,
  apr: 1,
  isPrivate: false,
  rewardToken: { address: MORPHO_TOKEN, symbol: "MORPHO", name: "Morpho", decimals: 18, type: "TOKEN" },
  ...overrides,
  params: { hooks: [], whitelist: [], ...params },
});

async function load() {
  const { getMarketSummaries } = await import("@/modules/market/data/getMarketSummaries");
  return getMarketSummaries;
}

beforeEach(() => {
  routes.clear();
  roots.length = 0;
  calls.length = 0;
  merkl.opportunities = [];
  merkl.down = false;
  merkl.requests = 0;
  supported.ids = { 1: [MARKET_A, MARKET_B, IDLE] };
  roots.push(root(MARKET_A, WSTETH), root(MARKET_B, WBTC), root(IDLE, ZERO));
  routes.set(`/v0/tokens/1:${USDC}`, token(USDC, "USDC", 6));
  routes.set(`/v0/tokens/1:${WSTETH}`, token(WSTETH, "wstETH", 18));
  routes.set(`/v0/tokens/1:${WBTC}`, token(WBTC, "WBTC", 8));
  routes.set(`/v0/tokens/1:${USDC}/price`, { data: { price: 1 } });
  market(MARKET_A, "33015947826037", { "6h": 0.059, "24h": 0.058, "7d": 0.057, "30d": 0.05 });
  market(MARKET_B, "1000000", { "6h": 0.04, "24h": null, "7d": 0.03 });
});

describe("getMarketSummaries", () => {
  it("builds each non-idle market's row from REST, with Merkl borrow rewards lowering the rate", async () => {
    merkl.opportunities = [
      {
        campaigns: [
          borrowCampaign({ apr: 1 }, { market: MARKET_A }),
          borrowCampaign({ type: "MORPHO", subType: 2, apr: 0.5 }, { marketId: MARKET_A }),
          // A supply campaign on the same market is not a borrow reward.
          borrowCampaign({ type: "MORPHOSUPPLY", apr: 9 }, { market: MARKET_A }),
        ],
      },
    ];
    const summaries = await (await load())();

    // Market id descending within a chain, the order GraphQL served.
    expect(summaries.map((row) => row.marketId)).toEqual([MARKET_B, MARKET_A]);
    const [b, a] = summaries;
    expect(a).toMatchObject({
      name: "wstETH / USDC",
      chain: { id: 1, name: "Ethereum" },
      lltv: { formatted: "0.86" },
      collateralAsset: { symbol: "wstETH", decimals: 18 },
      loanAsset: { symbol: "USDC", decimals: 6 },
      totalBorrowed: { raw: "33015947826037", formatted: "33015947.826037", usd: 33015947.826037 },
    });
    expect(a?.borrowApy6h.afterFees).toBe(0.059);
    expect(a?.borrowApy6h.total).toBeCloseTo(0.044);
    expect(a?.borrowApy6h.rewards).toEqual([{ asset: expect.objectContaining({ symbol: "MORPHO" }), apr: 0.015 }]);
    expect(a?.borrowApy30d.total).toBeCloseTo(0.035);
    // A window REST does not serve reads as 0, as a null GraphQL field did.
    expect(b?.borrowApy1d).toEqual({ afterFees: 0, total: 0, rewards: [] });
    expect(b?.borrowApy30d.afterFees).toBe(0);
    expect(b?.borrowApy7d.total).toBe(0.03);
  });

  it("shows borrow rewards with Core's token metadata, read for the shown markets only", async () => {
    const FXN_TOKEN = "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09";
    routes.set(`/v0/tokens/1:${MORPHO_TOKEN}`, token(MORPHO_TOKEN, "MORPHO.core", 6));
    // Market B is skipped (REST cannot describe its collateral): its reward token is never read.
    routes.delete(`/v0/tokens/1:${WBTC}`);
    merkl.opportunities = [
      {
        campaigns: [
          borrowCampaign({ apr: 1 }, { market: MARKET_A }),
          borrowCampaign(
            { apr: 2, rewardToken: { address: FXN_TOKEN, symbol: "FXN", decimals: 18, type: "TOKEN" } },
            { market: MARKET_B },
          ),
        ],
      },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const [a] = await (await load())();

    expect(a?.borrowApy6h.rewards).toEqual([
      { asset: expect.objectContaining({ symbol: "MORPHO.core", name: "MORPHO.core", decimals: 6 }), apr: 0.01 },
    ]);
    expect(calls).toContainEqual({ path: `/v0/tokens/1:${MORPHO_TOKEN}`, revalidate: 86_400 });
    expect(calls.map(({ path }) => path)).not.toContain(`/v0/tokens/1:${FXN_TOKEN}`);
    warn.mockRestore();
  });

  it("reads the idle market's nothing, each token and price once, with day caches and a minute for prices", async () => {
    await (await load())();

    expect(calls.filter((call) => call.path.includes(IDLE.slice(2)))).toEqual([]);
    expect(calls.filter((call) => call.path === `/v0/tokens/1:${USDC}`)).toHaveLength(1);
    expect(calls).toContainEqual({ path: "/v0/blue/markets", revalidate: 86_400 });
    expect(calls).toContainEqual({ path: `/v0/tokens/1:${WSTETH}`, revalidate: 86_400 });
    expect(calls.filter((call) => call.path === `/v0/tokens/1:${USDC}/price`)).toEqual([
      { path: `/v0/tokens/1:${USDC}/price`, revalidate: 60 },
    ]);
    expect(calls).toContainEqual({ path: `/v0/blue/markets/1:${MARKET_A}/state`, revalidate: undefined });
    // 1 root list + 2 per market + 3 tokens + 1 loan price; one Merkl read for the chain.
    expect(calls).toHaveLength(1 + 2 * 2 + 3 + 1);
    expect(merkl.requests).toBe(1);
  });

  it("skips a market REST does not know or whose collateral it cannot describe", async () => {
    routes.delete(`/v0/blue/markets/1:${MARKET_A}/state`);
    routes.delete(`/v0/tokens/1:${WBTC}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect((await load())()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("fails the list on a 429, so Next keeps the last good page", async () => {
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(
      `/v0/blue/markets/1:${MARKET_B}/apy-averages`,
      new MorphoRestError(429, "/apy-averages", "Too Many Requests"),
    );
    await expect((await load())()).rejects.toThrow("Morpho REST 429");

    market(MARKET_B, "1000000", {});
    routes.set(`/v0/tokens/1:${USDC}/price`, new MorphoRestError(429, "/price", "Too Many Requests"));
    await expect((await load())()).rejects.toThrow("Morpho REST 429");
  });

  it("renders without USD on another price failure, and with the native rate when Merkl is down", async () => {
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(`/v0/tokens/1:${USDC}/price`, new MorphoRestError(500, "/price", "Internal Server Error"));
    merkl.down = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const [, a] = await (await load())();
    expect(a?.totalBorrowed.usd).toBeNull();
    expect(a?.borrowApy6h).toEqual({ afterFees: 0.059, total: 0.059, rewards: [] });
    error.mockRestore();
  });
});
