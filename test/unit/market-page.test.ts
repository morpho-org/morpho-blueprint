import { AdaptiveCurveIrmLib, MarketUtils } from "@morpho-org/blue-sdk";
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

const MARKET = "0x000000000000000000000000000000000000000000000000000000000000beef";
const LOAN = getAddress("0x00000000000000000000000000000000000000c1");
const COLLATERAL = getAddress("0x00000000000000000000000000000000000000c2");
const ORACLE = getAddress("0x00000000000000000000000000000000000000a1");
const IRM = getAddress("0x00000000000000000000000000000000000000a2");
const CURATOR = getAddress("0x00000000000000000000000000000000000000a3");
const OWNER = getAddress("0x00000000000000000000000000000000000000a4");
const ZERO = "0x0000000000000000000000000000000000000000";
// Configured mainnet vaults in the demo config.
const VAULT_V1 = getAddress("0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB");
const VAULT_V2 = getAddress("0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757");
const BASE = `/v0/blue/markets/1:${MARKET}`;
// 4% a year at target, per second.
const RATE_AT_TARGET = 1268391679n;

const merkl: { borrowRewards: { address: string; apr: number }[] } = { borrowRewards: [] };
vi.mock("@/modules/reward/data/getMerklRewardIndex", async () => {
  const { emptyMerklRewardIndex } = await import("@/modules/reward/data/merklRewardApys");
  return {
    getMerklRewardIndex: async () => {
      const index = emptyMerklRewardIndex();
      index.marketBorrow.set(
        MARKET,
        merkl.borrowRewards.map(({ address, apr }) => ({
          asset: {
            address: getAddress(address),
            symbol: "RWD",
            name: "Reward",
            decimals: 18,
            icon: null,
            category: null,
          },
          apr,
          vaultV2Only: false,
        })),
      );
      for (const { address } of merkl.borrowRewards) index.rewardTokenChains.set(address.toLowerCase(), 1);
      return index;
    },
  };
});

const blueprint = { enabled: false };
vi.mock("@/common/utils/morphoApiConfig", () => ({ isBlueprintApiEnabled: () => blueprint.enabled }));

const routes = new Map<string, unknown>();
const calls: string[] = [];
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string, query?: Record<string, unknown>) => {
    const key = query?.lookback ? `${path}?${query.lookback}` : path;
    calls.push(key);
    const value = routes.get(key);
    if (value instanceof Error) throw value;
    return value ?? null;
  },
  fetchAllMorphoRestPages: async (path: string) => {
    calls.push(path);
    return (routes.get(path) as unknown[] | undefined) ?? [];
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
}));

function token(address: string, symbol: string, decimals: number) {
  return { data: { address, name: symbol, symbol, decimals, logo_uri: null, tags: [] } };
}

function seedMarket() {
  routes.set(BASE, {
    data: {
      loan_token: LOAN,
      collateral_token: COLLATERAL,
      oracle_address: ORACLE,
      irm_address: IRM,
      lltv_wad: "860000000000000000",
    },
  });
  routes.set(`${BASE}/state`, {
    data: {
      total_supply_assets: "1000000000", // 1,000 USDC
      total_borrow_assets: "800000000",
      fee_wad: "0",
      rate_at_target_per_second_wad: RATE_AT_TARGET.toString(),
    },
  });
  routes.set(`${BASE}/liquidity`, {
    data: { market_liquidity: "200000000", reallocatable_liquidity: "50000000" },
  });
  routes.set(`${BASE}/apy-averages`, {
    data: { borrow_apy_averages: { "6h": 0.05, "24h": 0.051, "7d": 0.052, "30d": 0.053 } },
  });
  routes.set(`/v0/oracles/1:${ORACLE}/state`, { data: { price: "2000000000000000000000000000" } });
  routes.set(`/v0/tokens/1:${LOAN}`, token(LOAN, "USDC", 6));
  routes.set(`/v0/tokens/1:${COLLATERAL}`, token(COLLATERAL, "WETH", 18));
  routes.set(`/v0/tokens/1:${LOAN}/price`, { data: { price: 1 } });
  routes.set(`/v0/tokens/1:${COLLATERAL}/price`, { data: { price: 2000 } });

  for (const lookback of ["seven_days", "ninety_days", "inception"]) {
    routes.set(`${BASE}/state/history?${lookback}`, {
      data: [
        // Before the first APY sample: kept, with no APY.
        {
          timestamp: 100,
          total_supply_assets: "900000000",
          total_borrow_assets: "700000000",
          total_collateral_assets: null,
        },
        {
          timestamp: 200,
          total_supply_assets: "1000000000",
          total_borrow_assets: "800000000",
          total_collateral_assets: "1000000000000000000",
        },
        {
          timestamp: 300,
          total_supply_assets: "1000000000",
          total_borrow_assets: "800000000",
          total_collateral_assets: "1000000000000000000",
        },
      ],
    });
    routes.set(`${BASE}/apy/history?${lookback}`, {
      data: [
        { timestamp: 200, supply_apy: 0.03, borrow_apy: 0.05 },
        // Implausible: a gap.
        { timestamp: 300, supply_apy: 0, borrow_apy: 50 },
      ],
    });
  }
}

function seedVaults() {
  routes.set(`/v0/vaults-v1/1:${VAULT_V1}/allocations`, {
    data: {
      allocations: [
        { market_id: MARKET, supply_assets: "300000000", supply_shares: "300000000000000", supply_cap: "500000000" },
      ],
    },
  });
  routes.set(`/v0/vaults-v1/1:${VAULT_V1}`, { data: { name: "Steakhouse USDC", curator: CURATOR } });
  routes.set(`/v0/vaults-v2/1:${VAULT_V2}/allocations`, {
    data: {
      allocations: [
        {
          caps: [
            {
              cap_type: "market_v1",
              market_id: MARKET,
              allocated_assets: "100000000",
              absolute_cap: "200000000",
              expected_supply_assets: "110000000",
            },
            { cap_type: "adapter", allocated_assets: "1", absolute_cap: "1" },
          ],
        },
        {
          caps: [
            // Expected 0 while the stored amount is not: the stored amount counts.
            {
              cap_type: "market_v1",
              market_id: MARKET,
              allocated_assets: "40000000",
              absolute_cap: "100000000",
              expected_supply_assets: "0",
            },
          ],
        },
      ],
    },
  });
  routes.set(`/v0/vaults-v2/1:${VAULT_V2}`, { data: { name: "Steakhouse High Yield", curator: null } });
  routes.set(`/v0/curators/1:${CURATOR}/details`, {
    data: { curators: [{ name: "Steakhouse", logo_uri: "https://logo", socials: [] }] },
  });
}

async function loadMarket() {
  const { getMarket } = await import("@/modules/market/data/getMarket");
  return getMarket(1, MARKET);
}

describe("getMarket (Core REST)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes.clear();
    calls.length = 0;
    merkl.borrowRewards = [];
    blueprint.enabled = false;
    seedMarket();
    seedVaults();
  });

  it("maps state, liquidity, the oracle price and utilization", async () => {
    const market = await loadMarket();
    expect(market.name).toBe("WETH / USDC");
    expect(market.isIdle).toBe(false);
    expect(market.totalSupplied).toEqual({ raw: "1000000000", formatted: "1000", usd: 1000 });
    expect(market.totalBorrowed.usd).toBe(800);
    expect(market.liquidityInMarket.usd).toBe(200);
    expect(market.utilization).toBeCloseTo(0.8, 12);
    expect(market.collateralPriceInLoanAsset?.formatted).toBe("2000");
    expect(market.oracleAddress).toBe(ORACLE);
    expect(market.irm.address).toBe(IRM);
    expect(market.loanAsset.priceUsd).toBe(1);
    expect(market.collateralAsset?.priceUsd).toBe(2000);
    expect(market.lltv.formatted).toBe("0.86");
  });

  it("nets the Merkl borrow rewards off every borrow APY window", async () => {
    merkl.borrowRewards = [{ address: "0x00000000000000000000000000000000000000d1", apr: 0.01 }];
    const market = await loadMarket();
    expect(market.borrowApy1d.afterFees).toBe(0.051);
    expect(market.borrowApy1d.total).toBeCloseTo(0.041, 12);
    expect(market.borrowApy7d.rewards).toHaveLength(1);
    expect(market.borrowApy6h.afterFees).toBe(0.05);
    expect(market.borrowApy30d.afterFees).toBe(0.053);
  });

  it("labels the borrow reward chips with Core's token metadata, Merkl's where Core has none", async () => {
    const CORE_KNOWN = getAddress("0x00000000000000000000000000000000000000d1");
    const CORE_UNKNOWN = getAddress("0x00000000000000000000000000000000000000d2");
    merkl.borrowRewards = [
      { address: CORE_KNOWN, apr: 0.01 },
      { address: CORE_UNKNOWN, apr: 0.02 },
    ];
    routes.set(`/v0/tokens/1:${CORE_KNOWN}`, token(CORE_KNOWN, "MORPHO", 18));
    const market = await loadMarket();
    expect(market.borrowApy7d.rewards.map((reward) => reward.asset.symbol)).toEqual(["MORPHO", "RWD"]);
  });

  it("computes the IRM curve with blue-sdk from the rate at target", async () => {
    const market = await loadMarket();
    const { curve } = market.irm;
    expect(curve).toHaveLength(101);
    const at = (u: number) => curve[Math.round(u * 100)];
    expect(at(0.9)?.borrowApy).toBeCloseTo(MarketUtils.rateToApy(RATE_AT_TARGET), 12);
    expect(at(0)?.borrowApy).toBeCloseTo(MarketUtils.rateToApy(RATE_AT_TARGET / 4n), 6);
    expect(at(1)?.borrowApy).toBeCloseTo(MarketUtils.rateToApy(RATE_AT_TARGET * 4n), 6);
    expect(at(0)?.supplyApy).toBe(0);
    const rateAt80 = AdaptiveCurveIrmLib.getBorrowRate(800000000000000000n, RATE_AT_TARGET, 0n).endBorrowRate;
    expect(at(0.8)?.supplyApy).toBeCloseTo(MarketUtils.rateToApy((rateAt80 * 8n) / 10n), 6);
  });

  it("serves no curve when the market's IRM has no rate at target", async () => {
    routes.set(`${BASE}/state`, {
      data: {
        total_supply_assets: "0",
        total_borrow_assets: "0",
        fee_wad: "0",
        rate_at_target_per_second_wad: null,
      },
    });
    const market = await loadMarket();
    expect(market.irm.curve).toEqual([]);
    expect(market.utilization).toBe(0);
  });

  it("lists the configured vaults supplying the market", async () => {
    const market = await loadMarket();
    const byProtocol = new Map(market.vaultAllocations.map((row) => [row.protocol, row]));
    expect(market.vaultAllocations).toHaveLength(2);

    const v1 = byProtocol.get(Erc4626VaultProtocol.MorphoV1);
    expect(v1?.vault).toMatchObject({ vaultAddress: VAULT_V1, name: "Steakhouse USDC", curatorAddress: CURATOR });
    expect(v1?.vault.metadata?.curator?.name).toBe("Steakhouse");
    expect(v1?.position.supplyAmount.usd).toBe(300);
    expect(v1?.supplyCap.usd).toBe(500);
    expect(v1?.marketSupplyShare).toBeCloseTo(0.3, 12);
    expect(v1?.enabled).toBe(true);

    const v2 = byProtocol.get(Erc4626VaultProtocol.MorphoV2);
    expect(v2?.position.supplyAmount.raw).toBe("150000000");
    expect(v2?.position.supplyShares).toBe("0");
    expect(v2?.supplyCap.raw).toBe("300000000");
    expect(v2?.vault.metadata?.curator).toBeNull();
    // Vaults that do not hold the market (no allocation read) are not read further.
    expect(calls.filter((path) => path.startsWith("/v0/vaults-v1/") && !path.endsWith("/allocations"))).toEqual([
      `/v0/vaults-v1/1:${VAULT_V1}`,
    ]);
  });

  it("treats a cleared curator as none, a V1 vault falling back to its owner", async () => {
    routes.set(`/v0/vaults-v1/1:${VAULT_V1}`, { data: { name: "Steakhouse USDC", curator: ZERO, owner: OWNER } });
    routes.set(`/v0/vaults-v2/1:${VAULT_V2}`, { data: { name: "Steakhouse High Yield", curator: ZERO, owner: OWNER } });
    routes.set(`/v0/curators/1:${OWNER}/details`, {
      data: { curators: [{ name: "Owner Labs", logo_uri: null, socials: [] }] },
    });
    const market = await loadMarket();
    const byProtocol = new Map(market.vaultAllocations.map((row) => [row.protocol, row]));
    expect(byProtocol.get(Erc4626VaultProtocol.MorphoV1)?.vault).toMatchObject({ curatorAddress: OWNER });
    expect(byProtocol.get(Erc4626VaultProtocol.MorphoV1)?.vault.metadata?.curator?.name).toBe("Owner Labs");
    expect(byProtocol.get(Erc4626VaultProtocol.MorphoV2)?.vault.curatorAddress).toBeNull();
    expect(calls).not.toContain(`/v0/curators/1:${ZERO}/details`);
  });

  it("builds the chart rows from state and APY history, USD hidden without the Blueprint key", async () => {
    const market = await loadMarket();
    const rows = market.historical?.daily ?? [];
    expect(rows.map((row) => row.bucketTimestamp)).toEqual([100, 200, 300]);
    expect(rows[0]?.borrowApy1d).toEqual({ base: null, total: null });
    expect(rows[1]?.borrowApy1d).toEqual({ base: 0.05, total: 0.05 });
    expect(rows[2]?.borrowApy1d).toEqual({ base: null, total: null });
    expect(rows[1]?.totalCollateral.formatted).toBe("1");
    expect(rows[1]?.totalSupplied).toEqual({ formatted: "1000", usd: null });
    expect(calls.some((path) => path.includes("token-prices"))).toBe(false);
  });

  it("prices the chart rows from the Blueprint price history when its key is set", async () => {
    blueprint.enabled = true;
    for (const [address, price] of [
      [LOAN, 1],
      [COLLATERAL, 2000],
    ] as const) {
      routes.set(`/v0/blueprint-app-api/token-prices/1:${address}/history`, {
        data: { points: [100, 200, 300].map((timestamp) => ({ timestamp, price_usd: price })) },
      });
    }
    const market = await loadMarket();
    const row = market.historical?.hourly[1];
    expect(row?.totalSupplied.usd).toBe(1000);
    expect(row?.totalBorrowed.usd).toBe(800);
    expect(row?.totalCollateral.usd).toBe(2000);
  });

  it("hides the charts when Core serves no history for the market", async () => {
    routes.delete(`${BASE}/state/history?inception`);
    const market = await loadMarket();
    expect(market.historical).toBeNull();
  });

  it("falls back to supply minus borrow when the liquidity read is missing", async () => {
    routes.delete(`${BASE}/liquidity`);
    const market = await loadMarket();
    expect(market.liquidityInMarket.usd).toBe(200);
    expect(market.availableToBorrow.usd).toBe(200);
  });

  describe("available to borrow", () => {
    const PA_VAULTS = `${BASE}/public-allocator-vaults`;
    const OTHER_V2 = getAddress("0x00000000000000000000000000000000000000b2");

    it("is the market's own liquidity when Core lists no Public Allocator V2 vault", async () => {
      // Core still reports reallocatable liquidity, but the borrow has no candidate to pull it from.
      routes.set(PA_VAULTS, { data: [] });
      const market = await loadMarket();
      expect(market.publicAllocatorVaultAddresses).toEqual([]);
      expect(market.publicAllocatorLiquidity.raw).toBe("0");
      expect(market.availableToBorrow).toEqual({ raw: "200000000", formatted: "200", usd: 200 });
    });

    it("adds Core's Public Allocator V2 reallocatable liquidity and keeps the vaults as candidates", async () => {
      routes.set(PA_VAULTS, {
        data: [
          // One row per adapter: the same vault can come twice, in any case.
          { vault_address: OTHER_V2.toLowerCase() },
          { vault_address: VAULT_V2 },
          { vault_address: OTHER_V2 },
        ],
      });
      const market = await loadMarket();
      expect(calls).toContain(PA_VAULTS);
      expect(market.publicAllocatorVaultAddresses).toEqual([OTHER_V2, VAULT_V2].sort());
      expect(market.publicAllocatorLiquidity).toEqual({ raw: "50000000", formatted: "50", usd: 50 });
      expect(market.availableToBorrow).toEqual({ raw: "250000000", formatted: "250", usd: 250 });
    });

    it("ignores the configured vaults V1: the borrow reallocates from vaults V2 only", async () => {
      routes.set(PA_VAULTS, { data: [] });
      routes.set(`${BASE}/liquidity`, {
        data: { market_liquidity: "200000000", reallocatable_liquidity: "0" },
      });
      const market = await loadMarket();
      // VAULT_V1 still supplies the market, but adds nothing.
      expect(market.vaultAllocations.some((v) => v.vault.vaultAddress === VAULT_V1)).toBe(true);
      expect(market.availableToBorrow.raw).toBe("200000000");
    });

    it("falls back to direct liquidity when the Public Allocator vaults read fails", async () => {
      routes.set(PA_VAULTS, new Error("Core 503"));
      const market = await loadMarket();
      expect(market.publicAllocatorVaultAddresses).toEqual([]);
      expect(market.availableToBorrow.raw).toBe("200000000");
    });

    it("counts no reallocation when Core serves no reallocatable figure", async () => {
      routes.set(PA_VAULTS, { data: [{ vault_address: VAULT_V2 }] });
      routes.set(`${BASE}/liquidity`, { data: { market_liquidity: "200000000", reallocatable_liquidity: null } });
      const market = await loadMarket();
      expect(market.publicAllocatorLiquidity.raw).toBe("0");
      expect(market.availableToBorrow.raw).toBe("200000000");
    });
  });

  it("throws when Core does not know the market", async () => {
    routes.delete(BASE);
    await expect(loadMarket()).rejects.toThrow("Market not found");
  });
});
