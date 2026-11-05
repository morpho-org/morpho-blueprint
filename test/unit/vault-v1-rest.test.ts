import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

const VAULT = getAddress("0x00000000000000000000000000000000000000a1");
const OWNER = getAddress("0x00000000000000000000000000000000000000b1");
const CURATOR = getAddress("0x00000000000000000000000000000000000000b2");
const GUARDIAN = getAddress("0x00000000000000000000000000000000000000b3");
const FEE_RECIPIENT = getAddress("0x00000000000000000000000000000000000000b4");
const USDC = getAddress("0x00000000000000000000000000000000000000c1");
const WETH = getAddress("0x00000000000000000000000000000000000000c2");
const MORPHO_TOKEN = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const WETH_MARKET = `0x${"11".repeat(32)}`;
const IDLE_MARKET = `0x${"22".repeat(32)}`;
const PENDING_MARKET = `0x${"33".repeat(32)}`;
const BASE = `/v0/vaults-v1/1:${VAULT}`;
const ZERO = "0x0000000000000000000000000000000000000000";

type ConfiguredVaults = Record<number, { address: string; protocol: string; description?: string }[]>;
const CONFIG = vi.hoisted(() => {
  const supportedVaults: ConfiguredVaults = {};
  return {
    apyWindow: "6h",
    chainConfig: { 1: { chain: { name: "Ethereum" }, iconSlug: "eth" } },
    featureFlags: {},
    supportedVaults,
  };
});
vi.mock("@/config", () => ({ APP_CONFIG: CONFIG }));

const blueprint = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/common/utils/morphoApiConfig", () => ({ isBlueprintApiEnabled: () => blueprint.enabled }));

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

// Core REST by path, plus `?<lookback>` for the APY routes. A missing entry is a 404 (`null`); an
// `Error` is thrown, as the client does on a non-2xx.
const routes = new Map<string, unknown>();
const lists = new Map<string, unknown[] | Error>();
const marketRoots = new Map<string, object>();
const calls: string[] = [];
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  // The Blueprint AUM route, by its `curators` filter.
  fetchMorphoRest: async (path: string, query?: { curators?: string[] }) => {
    const key = query?.curators ? `${path}?${query.curators.join(",")}` : path;
    calls.push(key);
    const body = routes.get(key);
    if (body instanceof Error) throw body;
    if (!body) throw new Error(`Morpho REST 404 on ${path}`);
    return body;
  },
  fetchMorphoRestResource: async (path: string, query?: { lookback?: string }) => {
    const key = query?.lookback ? `${path}?${query.lookback}` : path;
    calls.push(key);
    const body = routes.get(key);
    if (body instanceof Error) throw body;
    return body ?? null;
  },
  fetchAllMorphoRestPages: async (path: string, query: { market_id?: string[] }) => {
    calls.push(query.market_id ? `${path}?${query.market_id.join(",")}` : path);
    const listed = lists.get(path);
    if (listed instanceof Error) throw listed;
    if (listed) return listed;
    return (query.market_id ?? []).flatMap((id) => {
      const root = marketRoots.get(id);
      return root ? [root] : [];
    });
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
  chunk: <T>(items: readonly T[]) => [items.slice()],
}));

const curatorDetails = (name: string) => ({
  data: {
    curators: [
      { id: name.toLowerCase(), name, logo_uri: null, socials: [{ type: "url", url: `https://${name}.xyz` }] },
    ],
  },
});

function seedVault({
  curator = CURATOR,
  guardian = GUARDIAN,
  feeRecipient = FEE_RECIPIENT,
  decimals = 6,
}: {
  curator?: string | null;
  guardian?: string | null;
  feeRecipient?: string | null;
  decimals?: number | null;
} = {}) {
  routes.set(BASE, {
    data: {
      chain_id: 1,
      address: VAULT,
      name: "Steakhouse USDC",
      asset: { address: USDC, decimals, name: "USD Coin", symbol: "USDC" },
      fee_wad: "50000000000000000",
      fee_recipient: feeRecipient,
      owner: OWNER,
      curator,
      guardian,
    },
  });
  routes.set(`${BASE}/state`, { data: { total_assets: "4000000", withdrawable_assets: "1500000" } });
  routes.set(`${BASE}/apy-averages?six_hours`, { data: { apy: 0.05 } });
  for (const [lookback, apy] of [
    ["seven_days", 0.04],
    ["thirty_days", 0.045],
    ["ninety_days", null],
    ["inception", 0.038],
  ] as const) {
    routes.set(`${BASE}/apy-averages?${lookback}`, { data: { apy } });
  }
  const row = (market_id: string, supply_assets: string, supply_cap: string, withdraw_queue_index: number | null) => ({
    market_id,
    supply_assets,
    supply_shares: `${supply_assets}000000`,
    supply_cap,
    supply_queue_index: withdraw_queue_index,
    withdraw_queue_index,
    pending: { supply_cap: null, removal: null },
  });
  // REST orders by market id; the withdraw queue puts the idle market first.
  routes.set(`${BASE}/allocations`, {
    data: {
      allocations: [
        row(WETH_MARKET, "3000000", "10000000", 1),
        row(IDLE_MARKET, "1000000", "5000000", 0),
        row(PENDING_MARKET, "0", "0", null),
      ],
    },
  });
  marketRoots.set(WETH_MARKET, {
    chain_id: 1,
    market_id: WETH_MARKET,
    loan_token: USDC,
    collateral_token: WETH,
    lltv_wad: "860000000000000000",
  });
  marketRoots.set(IDLE_MARKET, {
    chain_id: 1,
    market_id: IDLE_MARKET,
    loan_token: USDC,
    collateral_token: "0x0000000000000000000000000000000000000000",
    lltv_wad: "0",
  });
  routes.set(`/v0/tokens/1:${USDC}`, {
    data: { address: USDC, name: "USD Coin", symbol: "USDC", decimals: 6, logo_uri: "usdc.svg", tags: ["stablecoin"] },
  });
  routes.set(`/v0/tokens/1:${WETH}`, {
    data: { address: WETH, name: "Wrapped Ether", symbol: "WETH", decimals: 18, logo_uri: "weth.svg", tags: null },
  });
  routes.set(`/v0/tokens/1:${USDC}/price`, { data: { price: 2 } });
  routes.set(`/v0/curators/1:${CURATOR}/details`, curatorDetails("Curator"));
  routes.set(`/v0/curators/1:${OWNER}/details`, curatorDetails("Owner"));
}

async function loadSummaries() {
  const { getVaultSummaries } = await import("@/modules/vault/data/getVaultSummaries");
  return getVaultSummaries();
}

async function loadVault() {
  const { getVault } = await import("@/modules/vault/data/getVault");
  return getVault(1, VAULT, Erc4626VaultProtocol.MorphoV1);
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  routes.clear();
  lists.clear();
  marketRoots.clear();
  calls.length = 0;
  merkl.opportunities = [];
  merkl.reads = 0;
  blueprint.enabled = false;
  CONFIG.supportedVaults = { 1: [{ address: VAULT, protocol: Erc4626VaultProtocol.MorphoV1 }] };
  seedVault();
});

describe("getVaultSummaries (vault V1 from Core REST)", () => {
  it("maps the root, state, APY window, token, curator and exposure onto the earn row", async () => {
    const [summary] = await loadSummaries();

    expect(summary).toEqual({
      __typename: "MorphoVault",
      chain: { id: 1, name: "Ethereum", icon: "https://cdn.morpho.org/assets/chains/eth.svg" },
      vaultAddress: VAULT,
      name: "Steakhouse USDC",
      asset: {
        address: USDC,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        icon: "usdc.svg",
        category: "Stable",
        priceUsd: 2,
      },
      totalAssets: { raw: "4000000", formatted: "4", usd: 8 },
      apy: { afterFees: 0.05, total: 0.05, rewards: [] },
      metadata: { description: null, curator: { name: "Curator", image: null, url: "https://Curator.xyz" } },
      curatorAum: undefined,
      isHidden: false,
      // Withdraw-queue order; the pending-only market is left out.
      marketAllocations: [
        {
          enabled: true,
          vaultSupplyShare: 0.25,
          position: { supplyAmount: { usd: 2 } },
          market: { collateralAsset: null },
        },
        {
          enabled: true,
          vaultSupplyShare: 0.75,
          position: { supplyAmount: { usd: 6 } },
          market: { collateralAsset: { icon: "weth.svg", name: "Wrapped Ether", symbol: "WETH" } },
        },
      ],
    });
  });

  it("looks up the curator from the owner when REST serves a cleared curator role as the zero address", async () => {
    seedVault({ curator: ZERO });

    const [summary] = await loadSummaries();

    expect(summary?.metadata?.curator).toEqual({ name: "Owner", image: null, url: "https://Owner.xyz" });
    expect(calls).not.toContain(`/v0/curators/1:${ZERO}/details`);
  });

  it("looks up the curator from the owner when the vault has no curator role", async () => {
    seedVault({ curator: null });

    const [summary] = await loadSummaries();

    expect(summary?.metadata?.curator).toEqual({ name: "Owner", image: null, url: "https://Owner.xyz" });
  });

  it("adds the vault's Merkl reward APRs, excluding vault-V2-only campaigns", async () => {
    merkl.opportunities = [
      {
        campaigns: [
          {
            id: "c1",
            type: "ERC20LOGPROCESSOR",
            subType: 0,
            computeChainId: 1,
            startTimestamp: 1_700_000_000,
            endTimestamp: 1_900_000_000,
            apr: 1.5,
            rewardToken: { address: MORPHO_TOKEN, symbol: "MORPHO", decimals: 18, icon: null, type: "TOKEN" },
            params: { hooks: [], whitelist: [], targetToken: VAULT },
          },
        ],
      },
    ];

    const [summary] = await loadSummaries();

    expect(summary?.apy.total).toBeCloseTo(0.065);
    expect(summary?.apy.rewards).toHaveLength(1);
  });

  it("reads descriptions from the Blueprint vault V1 metadata route when it is on", async () => {
    blueprint.enabled = true;
    lists.set("/v0/blueprint-app-api/vaults-v1/metadata", [
      { chain_id: 1, vault_address: VAULT, description: "Curated description" },
    ]);

    const [summary] = await loadSummaries();

    expect(summary?.metadata?.description).toBe("Curated description");
  });

  it("keeps the row with an empty exposure tooltip when the allocations read fails", async () => {
    routes.set(`${BASE}/allocations`, new Error("Morpho REST 500"));

    const [summary] = await loadSummaries();

    expect(summary?.__typename === "MorphoVault" && summary.marketAllocations).toEqual([]);
    expect(summary?.totalAssets.raw).toBe("4000000");
  });

  it("keeps the row with an empty exposure tooltip when the market params read fails", async () => {
    lists.set("/v0/blue/markets", new Error("Morpho REST 500"));

    const [summary] = await loadSummaries();

    expect(summary?.__typename === "MorphoVault" && summary.marketAllocations).toEqual([]);
  });

  it("drops a vault REST does not know, and one whose asset decimals are unknown", async () => {
    routes.delete(`${BASE}/state`);
    expect(await loadSummaries()).toEqual([]);

    vi.resetModules();
    seedVault({ decimals: null });
    routes.set(`/v0/tokens/1:${USDC}`, { data: { address: USDC, name: null, symbol: null, decimals: null } });
    expect(await loadSummaries()).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(`Vault asset decimals unknown: 1:${VAULT}`);
  });

  it("fails when the vault state read fails", async () => {
    routes.set(`${BASE}/state`, new Error("Morpho REST 500"));

    await expect(loadSummaries()).rejects.toThrow("Morpho REST 500");
  });

  it("sets the curator's AUM from the Blueprint API when it is on, and reads nothing when it is off", async () => {
    routes.set("/v0/blueprint-app-api/curators/aum?curator", { data: [{ curator_id: "curator", aum_usd: 7_000_000 }] });

    const [off] = await loadSummaries();
    expect(off?.curatorAum).toBeUndefined();
    expect(calls).not.toContain("/v0/blueprint-app-api/curators/aum?curator");

    blueprint.enabled = true;
    const [on] = await loadSummaries();
    expect(on?.curatorAum).toBe(7_000_000);
  });
});

describe("getVault (vault V1 details from Core REST)", () => {
  it("maps fees, roles, liquidity, APY averages and the withdraw-queue allocations", async () => {
    const vault = await loadVault();

    expect(vault).toMatchObject({
      __typename: "MorphoVault",
      name: "Steakhouse USDC",
      totalAssets: { raw: "4000000", formatted: "4", usd: 8 },
      totalLiquidity: { usd: 3 },
      apyAverages: { sevenDays: 0.04, thirtyDays: 0.045, ninetyDays: null, inception: 0.038 },
      performanceFeeRaw: 0.05,
      feeRecipientAddress: FEE_RECIPIENT,
      ownerAddress: OWNER,
      curatorAddress: CURATOR,
      guardianAddress: GUARDIAN,
    });
    if (vault.__typename !== "MorphoVault") throw new Error("expected a vault V1");
    expect(
      vault.marketAllocations.map(({ market, enabled, vaultSupplyShare, position, supplyCap }) => ({
        id: market.marketId,
        collateral: market.collateralAsset?.symbol ?? null,
        enabled,
        vaultSupplyShare,
        supply: position.supplyAmount,
        shares: position.supplyShares,
        cap: supplyCap.formatted,
      })),
    ).toEqual([
      {
        id: IDLE_MARKET,
        collateral: null,
        enabled: true,
        vaultSupplyShare: 0.25,
        supply: { raw: "1000000", formatted: "1", usd: 2 },
        shares: "1000000000000",
        cap: "5",
      },
      {
        id: WETH_MARKET,
        collateral: "WETH",
        enabled: true,
        vaultSupplyShare: 0.75,
        supply: { raw: "3000000", formatted: "3", usd: 6 },
        shares: "3000000000000",
        cap: "10",
      },
    ]);
  });

  it("reads the root, state and asset price once, with no tooltip read and one Merkl read", async () => {
    await loadVault();

    const count = (key: string) => calls.filter((call) => call === key).length;
    expect(count(BASE)).toBe(1);
    expect(count(`${BASE}/state`)).toBe(1);
    expect(count(`${BASE}/allocations`)).toBe(1);
    expect(count(`/v0/tokens/1:${USDC}/price`)).toBe(1);
    // The details' market read only: the summary skips the tooltip's.
    expect(calls.filter((call) => call.startsWith("/v0/blue/markets?"))).toEqual([
      `/v0/blue/markets?${IDLE_MARKET},${WETH_MARKET}`,
    ]);
    expect(merkl.reads).toBe(1);
  });

  it("hides a zero fee recipient and shows cleared roles as the zero address", async () => {
    seedVault({ curator: ZERO, guardian: ZERO, feeRecipient: ZERO });

    const vault = await loadVault();

    expect(vault).toMatchObject({
      feeRecipientAddress: null,
      curatorAddress: ZERO,
      guardianAddress: ZERO,
      metadata: { curator: { name: "Owner" } },
    });
  });

  it("shows the curator's AUM on the vault page, and none when the AUM route fails", async () => {
    blueprint.enabled = true;
    routes.set("/v0/blueprint-app-api/curators/aum?curator", { data: [{ curator_id: "curator", aum_usd: 7_000_000 }] });
    expect((await loadVault()).curatorAum).toBe(7_000_000);

    routes.set("/v0/blueprint-app-api/curators/aum?curator", new Error("Morpho REST 500"));
    expect((await loadVault()).curatorAum).toBeUndefined();
  });

  it("throws not found when REST does not know the vault", async () => {
    routes.delete(BASE);

    await expect(loadVault()).rejects.toThrow(`Vault not found: 1:${VAULT}`);
  });
});
