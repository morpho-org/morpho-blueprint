import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock("@/modules/vault/utils/normalizeVault", () => ({ normalizeVault: <T>(vault: T) => vault }));
// The fixtures read the 6h header APY window; the template's own config uses another one.
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return { ...actual, APP_CONFIG: { ...actual.APP_CONFIG, apyWindow: "6h" } };
});
// Vault V1 pages still read their summary and details from GraphQL.
const graphql = vi.hoisted((): { queries: number } => ({ queries: 0 }));
vi.mock("@/common/utils/executeMorphoQuery", () => ({
  executeMorphoQuery: async () => {
    graphql.queries += 1;
    return { vaults: { items: [] } };
  },
}));

const VAULT = "0x0000000000000000000000000000000000000001";
const ADAPTER = getAddress("0x00000000000000000000000000000000000000a1");
const USDC = getAddress("0x00000000000000000000000000000000000000c1");
const WETH = getAddress("0x00000000000000000000000000000000000000c2");
const VAULT_V1 = getAddress("0x00000000000000000000000000000000000000b1");
const MARKET = `0x${"11".repeat(32)}`;
const EMPTY_MARKET = `0x${"22".repeat(32)}`;
const BASE = `/v0/vaults-v2/1:${VAULT}`;
const MORPHO_TOKEN = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";

// Merkl serves the campaigns in `merkl.opportunities`, indexed as of a fixed time.
const merkl = vi.hoisted((): { opportunities: unknown[]; reads: number } => ({ opportunities: [], reads: 0 }));
vi.mock("@/modules/reward/data/getMerklRewardIndex", () => ({
  getMerklRewardIndex: async () => {
    merkl.reads += 1;
    return (await import("@/modules/reward/data/merklRewardApys")).indexMerklRewards(
      merkl.opportunities,
      1_800_000_000,
    );
  },
}));
const merklCampaign = (type: string, apr: number, params: Record<string, unknown>) => ({
  id: `${type}-${apr}`,
  type,
  subType: 0,
  computeChainId: 1,
  startTimestamp: 1_700_000_000,
  endTimestamp: 1_900_000_000,
  apr,
  rewardToken: { address: MORPHO_TOKEN, symbol: "MORPHO", decimals: 18, icon: null, type: "TOKEN", isTest: false },
  params: { hooks: [], whitelist: [], ...params },
});
const MORPHO_REWARD = {
  address: MORPHO_TOKEN,
  symbol: "MORPHO",
  name: "MORPHO",
  decimals: 18,
  icon: null,
  category: null,
};

const CURATOR = "0x00000000000000000000000000000000000000cc";

const routes = new Map<string, unknown>();
const marketRoots = new Map<string, object[]>();
const calls: string[] = [];
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string, query?: { lookback?: string }) => {
    const key = query?.lookback ? `${path}?${query.lookback}` : path;
    calls.push(key);
    return routes.get(key) ?? null;
  },
  fetchAllMorphoRestPages: async (path: string, query: { market_id: string[] }) => {
    calls.push(`${path}?${query.market_id.join(",")}`);
    return query.market_id.flatMap((id) => marketRoots.get(id) ?? []);
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
  chunk: <T>(items: T[]) => [items],
}));

function seedVault({
  adapterKind = "morpho_market_v1_v2",
  withAdapterCap = true,
  assetDecimals = 6,
  expectedSupplyAssets = "3000000",
  managementFeeWad = null,
}: {
  adapterKind?: string;
  withAdapterCap?: boolean;
  assetDecimals?: number | null;
  expectedSupplyAssets?: string;
  managementFeeWad?: string | null;
} = {}) {
  // The root serves both the summary (name, asset, curator) and the details (fees, roles).
  routes.set(BASE, {
    data: {
      address: VAULT,
      name: "Test Vault",
      asset: { address: USDC, decimals: assetDecimals, name: "USD Coin", symbol: "USDC" },
      curator: CURATOR,
      performance_fee_wad: "50000000000000000",
      management_fee_wad: managementFeeWad,
    },
  });
  routes.set(`/v1/vaults-v2/1:${VAULT}/state`, { data: { total_assets: "1000000", idle_assets: "500000" } });
  // The header APY window (6h).
  routes.set(`/v1/vaults-v2/1:${VAULT}/apy-averages?six_hours`, { data: { apy: 0.05 } });
  routes.set(`/v0/curators/1:${CURATOR}/details`, {
    data: { curators: [{ name: "Curator", logo_uri: null, socials: [{ type: "url", url: "https://curator.xyz" }] }] },
  });
  routes.set(`${BASE}/sentinels`, { data: [{ role_address: "0x00000000000000000000000000000000000000dd" }] });
  for (const [lookback, apy] of [
    ["seven_days", 0.04],
    ["thirty_days", 0.045],
    ["ninety_days", 0.05],
    ["inception", 0.038],
  ] as const) {
    routes.set(`/v1/vaults-v2/1:${VAULT}/apy-averages?${lookback}`, { data: { apy } });
  }
  routes.set(`${BASE}/allocations`, {
    data: {
      allocations: [
        {
          adapter_address: ADAPTER,
          adapter_kind: adapterKind,
          target:
            adapterKind === "morpho_vault_v1" ? { type: "vault_v1", vault_address: VAULT_V1 } : { type: "blue_market" },
          caps: [
            ...(withAdapterCap
              ? [
                  {
                    cap_type: "adapter",
                    allocated_assets: "2900000",
                    real_assets: "3000000",
                    absolute_cap: "10000000",
                    relative_cap_wad: "500000000000000000",
                  },
                ]
              : []),
            {
              cap_type: "market_v1",
              market_id: MARKET,
              allocated_assets: "2900000",
              expected_supply_assets: expectedSupplyAssets,
              absolute_cap: "8000000",
              relative_cap_wad: "1000000000000000000",
            },
            {
              cap_type: "market_v1",
              market_id: EMPTY_MARKET,
              allocated_assets: "0",
              expected_supply_assets: "0",
              absolute_cap: "1000000",
              relative_cap_wad: "1000000000000000000",
            },
          ],
        },
      ],
    },
  });
  marketRoots.set(MARKET, [
    { chain_id: 1, market_id: MARKET, loan_token: USDC, collateral_token: WETH, lltv_wad: "860000000000000000" },
  ]);
  routes.set(`/v0/blue/markets/1:${MARKET}/state`, { data: { total_supply_assets: "10000000" } });
  routes.set(`/v0/blue/markets/1:${MARKET}/apy-averages`, {
    data: { supply_apy_averages: { "6h": 0.06, "24h": 0.061, "7d": 0.062, "30d": 0.063 } },
  });
  routes.set(`/v0/tokens/1:${USDC}`, {
    data: { address: USDC, name: "USD Coin", symbol: "USDC", decimals: 6, logo_uri: "usdc.svg", tags: ["stablecoin"] },
  });
  routes.set(`/v0/tokens/1:${WETH}`, {
    data: { address: WETH, name: "Wrapped Ether", symbol: "WETH", decimals: 18, logo_uri: null, tags: null },
  });
  routes.set(`/v0/tokens/1:${USDC}/price`, { data: { price: 2 } });
}

async function loadVault() {
  const { getVault } = await import("@/modules/vault/data/getVault");
  return getVault(1, VAULT, Erc4626VaultProtocol.MorphoV2);
}

describe("getVault (Vault V2 details from REST)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes.clear();
    marketRoots.clear();
    calls.length = 0;
    merkl.opportunities = [];
    merkl.reads = 0;
  });

  it("reads the header fields from the REST summary, with Merkl read once for the whole page", async () => {
    seedVault();
    merkl.opportunities = [{ campaigns: [merklCampaign("ERC20LOGPROCESSOR", 1.5, { targetToken: VAULT })] }];
    const vault = await loadVault();

    expect(vault).toMatchObject({
      __typename: "MorphoVaultV2",
      name: "Test Vault",
      chain: { id: 1, name: "Ethereum" },
      asset: { address: USDC, symbol: "USDC", name: "USD Coin", decimals: 6, icon: "usdc.svg", priceUsd: 2 },
      metadata: { description: null, curator: { name: "Curator", image: null, url: "https://curator.xyz" } },
    });
    expect(vault.apy).toEqual({ afterFees: 0.05, total: 0.065, rewards: [{ asset: MORPHO_REWARD, apr: 0.015 }] });
    expect(merkl.reads).toBe(1);
  });

  it("reads a vault V1 from GraphQL and its V1 history, with no vault V2 or Merkl read", async () => {
    const { getVault } = await import("@/modules/vault/data/getVault");

    await expect(getVault(1, VAULT, Erc4626VaultProtocol.MorphoV1)).rejects.toThrow(`Vault not found: 1:${VAULT}`);
    expect(graphql.queries).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.startsWith(`/v0/vaults-v1/1:${VAULT}/`))).toBe(true);
    expect(merkl.reads).toBe(0);
  });

  it("reads the vault root, its state and the asset price once for the whole page", async () => {
    seedVault();
    await loadVault();

    const count = (path: string) => calls.filter((call) => call === path).length;
    expect(count(BASE)).toBe(1);
    expect(count(`/v1/vaults-v2/1:${VAULT}/state`)).toBe(1);
    // The asset is also the loan token of the vault's market.
    expect(count(`/v0/tokens/1:${USDC}/price`)).toBe(1);
  });

  it("annualizes the per-second management fee and leaves the performance fee as served", async () => {
    // 1% a year as the on-chain per-second WAD rate: 1e16 / 31,536,000 seconds, rounded down.
    seedVault({ managementFeeWad: "317097919" });
    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");

    expect(vault.managementFee).toEqual({ formatted: "0.009999999973584" });
    expect(Number(vault.managementFee.formatted)).toBeCloseTo(0.01, 8);
    // A plain WAD fraction (5%): not scaled by time.
    expect(vault.performanceFee).toEqual({ formatted: "0.05" });
  });

  it("reads fees, roles and the four APY averages from REST", async () => {
    seedVault();
    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");

    // A null fee WAD is a fee never set: 0.
    expect(vault.performanceFee).toEqual({ formatted: "0.05" });
    expect(vault.managementFee).toEqual({ formatted: "0" });
    expect(vault.curatorAddress).toBe(getAddress(CURATOR));
    expect(vault.sentinelAddresses).toEqual([getAddress("0x00000000000000000000000000000000000000dd")]);
    expect(vault.apyAverages).toEqual({ sevenDays: 0.04, thirtyDays: 0.045, ninetyDays: 0.05, inception: 0.038 });
  });

  it("builds the adapter breakdown from the allocations, dropping markets with nothing allocated", async () => {
    seedVault();
    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");

    // Accrued adapter assets plus idle assets, priced with the summary's asset price.
    expect(vault.totalAssets).toEqual({ raw: "3500000", formatted: "3.5", usd: 7 });
    expect(vault.allocations).toHaveLength(1);
    const [adapter] = vault.allocations;
    if (adapter?.__typename !== "MarketV1Adapter") throw new Error("expected a market adapter");
    expect(adapter.name).toBe("Morpho Market Adapter");
    expect(adapter.adapterCap).toEqual({
      allocation: { raw: "3000000", formatted: "3", usd: 6 },
      relativeCap: { raw: "500000000000000000", formatted: "0.5" },
      absoluteCap: { raw: "10000000", formatted: "10", usd: 20 },
    });
    expect(adapter.marketCaps).toHaveLength(1);
    const [marketCap] = adapter.marketCaps;
    expect(marketCap?.allocation).toEqual({ raw: "3000000", formatted: "3", usd: 6 });
    expect(marketCap?.market).toMatchObject({
      marketId: MARKET,
      name: "WETH / USDC",
      isIdle: false,
      lltv: { formatted: "0.86" },
      loanAsset: { symbol: "USDC", icon: "usdc.svg", category: "Stable" },
      collateralAsset: { symbol: "WETH", decimals: 18 },
      totalSupplied: { usd: 20 },
      supplyApy6h: { afterFees: 0.06, total: 0.06, rewards: [] },
      supplyApy1d: { afterFees: 0.061, total: 0.061, rewards: [] },
      supplyApy7d: { afterFees: 0.062, total: 0.062, rewards: [] },
      supplyApy30d: { afterFees: 0.063, total: 0.063, rewards: [] },
    });
    // The empty market is never read.
    expect(calls.some((call) => call.includes(EMPTY_MARKET))).toBe(false);
  });

  it.each([
    // A vault V1 REST does not know stays an unexpanded row.
    ["morpho_vault_v1", "Morpho Vault V1 Adapter"],
    ["morpho_vault_v2", "Morpho Vault V2 Adapter"],
    ["unknown", "Vault Adapter"],
    ["shipped_later", "Vault Adapter"],
  ])("renders a %s adapter as a row with no breakdown", async (adapterKind, name) => {
    seedVault({ adapterKind });
    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");

    expect(vault.allocations).toEqual([
      expect.objectContaining({ __typename: "Erc4626VaultAdapter", name, adapterAddress: ADAPTER, vault: null }),
    ]);
    expect(vault.allocations[0]?.adapterCap?.allocation.raw).toBe("3000000");
  });

  it("expands a vault V1 held through an adapter into its market allocations", async () => {
    seedVault({ adapterKind: "morpho_vault_v1" });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}`, { data: { name: "Inner V1", asset: { address: USDC } } });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}/allocations`, {
      data: {
        allocations: [{ market_id: MARKET, supply_assets: "3000000", supply_shares: "42", supply_cap: "5000000" }],
      },
    });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}/apy-averages?six_hours`, { data: { apy: 0.07 } });

    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");
    const [adapter] = vault.allocations;
    if (adapter?.__typename !== "Erc4626VaultAdapter") throw new Error("expected a vault adapter");
    expect(adapter.name).toBe("Inner V1");
    expect(adapter.vault).toMatchObject({
      vaultAddress: VAULT_V1,
      name: "Inner V1",
      asset: { symbol: "USDC" },
      apy: { afterFees: 0.07, total: 0.07, rewards: [] },
      totalAssets: { raw: "3000000", usd: 6 },
    });
    expect(adapter.vault?.marketAllocations).toEqual([
      expect.objectContaining({
        enabled: true,
        vaultSupplyShare: 1,
        position: { supplyAmount: { raw: "3000000", formatted: "3", usd: 6 }, supplyShares: "42" },
        supplyCap: { raw: "5000000", formatted: "5", usd: 10 },
        market: expect.objectContaining({ marketId: MARKET, name: "WETH / USDC" }),
      }),
    ]);
  });

  it("adds Merkl reward APRs to the vault V1 behind an adapter and to its markets", async () => {
    seedVault({ adapterKind: "morpho_vault_v1" });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}`, { data: { name: "Inner V1", asset: { address: USDC } } });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}/allocations`, {
      data: {
        allocations: [{ market_id: MARKET, supply_assets: "3000000", supply_shares: "42", supply_cap: "5000000" }],
      },
    });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}/apy-averages?six_hours`, { data: { apy: 0.07 } });
    merkl.opportunities = [
      {
        campaigns: [
          merklCampaign("MORPHOSUPPLY", 2, { market: MARKET }),
          // The child campaign Merkl forwards to the vault V1 supplying that market.
          merklCampaign("ERC20LOGPROCESSOR", 1, { targetToken: VAULT_V1 }),
        ],
      },
    ];

    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");
    const [adapter] = vault.allocations;
    if (adapter?.__typename !== "Erc4626VaultAdapter") throw new Error("expected a vault adapter");
    expect(adapter.vault?.apy).toEqual({
      afterFees: 0.07,
      total: 0.08,
      rewards: [{ asset: MORPHO_REWARD, apr: 0.01 }],
    });
    // One read for the vault V1 rows and the market rows together.
    expect(merkl.reads).toBe(1);
    expect(adapter.vault?.marketAllocations[0]?.market.supplyApy6h).toEqual({
      afterFees: 0.06,
      total: 0.08,
      rewards: [{ asset: MORPHO_REWARD, apr: 0.02 }],
    });
  });

  it("names a vault V1 REST serves without a name by its address", async () => {
    seedVault({ adapterKind: "morpho_vault_v1" });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}`, { data: { name: null, asset: { address: USDC } } });
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}/allocations`, { data: { allocations: [] } });

    const vault = await loadVault();
    const [adapter] = vault.__typename === "MorphoVaultV2" ? vault.allocations : [];
    if (adapter?.__typename !== "Erc4626VaultAdapter") throw new Error("expected a vault adapter");
    expect(adapter.vault?.name).toBe(VAULT_V1);
  });

  it("skips a market whose collateral token REST cannot describe, rather than showing it as idle", async () => {
    seedVault();
    routes.delete(`/v0/tokens/1:${WETH}`);

    const vault = await loadVault();
    const [adapter] = vault.__typename === "MorphoVaultV2" ? vault.allocations : [];
    if (adapter?.__typename !== "MarketV1Adapter") throw new Error("expected a market adapter");
    expect(adapter.marketCaps).toEqual([]);
  });

  it("falls back to the markets' assets when an adapter has no adapter cap", async () => {
    seedVault({ withAdapterCap: false });

    const vault = await loadVault();
    if (vault.__typename !== "MorphoVaultV2") throw new Error("expected a vault V2");
    expect(vault.allocations[0]?.adapterCap).toEqual({
      allocation: { raw: "3000000", formatted: "3", usd: 6 },
      relativeCap: { raw: "0", formatted: "0" },
      absoluteCap: { raw: "0", formatted: "0", usd: null },
    });
  });

  it("uses the stored allocation when REST's accrued estimate is 0 for an allocated market", async () => {
    // The seeded market cap's accrual state predates the position.
    seedVault({ expectedSupplyAssets: "0" });

    const vault = await loadVault();
    const [adapter] = vault.__typename === "MorphoVaultV2" ? vault.allocations : [];
    if (adapter?.__typename !== "MarketV1Adapter") throw new Error("expected a market adapter");
    expect(adapter.marketCaps.map((cap) => cap.allocation.raw)).toEqual(["2900000"]);
  });

  it("falls back to the token's decimals when REST serves the vault asset's as null", async () => {
    seedVault({ assetDecimals: null });

    const vault = await loadVault();
    expect(vault.totalAssets).toEqual({ raw: "3500000", formatted: "3.5", usd: 7 });
  });

  it("fails rather than guess when no source knows the vault asset's decimals", async () => {
    seedVault({ assetDecimals: null });
    routes.delete(`/v0/tokens/1:${USDC}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The summary drops a vault with unknown decimals, so the page has no vault to show.
    await expect(loadVault()).rejects.toThrow(`Vault not found: 1:${VAULT}`);
    expect(warn).toHaveBeenCalledWith(`Vault asset decimals unknown: 1:${VAULT}`);
    warn.mockRestore();
  });

  it("fills null token names and symbols from each other, then a placeholder", async () => {
    seedVault();
    routes.set(`/v0/tokens/1:${WETH}`, {
      data: { address: WETH, name: null, symbol: "WETH", decimals: 18, logo_uri: null, tags: null },
    });
    routes.set(`/v0/tokens/1:${USDC}`, {
      data: { address: USDC, name: null, symbol: null, decimals: 6, logo_uri: null, tags: null },
    });

    const vault = await loadVault();
    const [adapter] = vault.__typename === "MorphoVaultV2" ? vault.allocations : [];
    if (adapter?.__typename !== "MarketV1Adapter") throw new Error("expected a market adapter");
    expect(adapter.marketCaps[0]?.market).toMatchObject({
      name: "WETH / UNKNOWN",
      collateralAsset: { name: "WETH", symbol: "WETH" },
      loanAsset: { name: "UNKNOWN", symbol: "UNKNOWN" },
    });
  });

  it("hides the curator AUM while its route is not in API prod", async () => {
    seedVault();
    const vault = await loadVault();
    expect(vault.curatorAum).toBeUndefined();
  });

  it("throws when REST does not know the vault", async () => {
    await expect(loadVault()).rejects.toThrow(`Vault not found: 1:${VAULT}`);
  });
});
