import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T>(fn: T) => fn }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

const CONFIG = vi.hoisted(() => ({
  supportedVaults: {} as Record<number, { address: string; protocol: string }[]>,
}));
vi.mock("@/config", () => ({ APP_CONFIG: CONFIG }));

const supportedMarketIds = vi.hoisted(() => ({ value: {} as Record<number, string[]> }));
vi.mock("@/modules/market/data/getSupportedMarketIds", () => ({
  getSupportedMarketIds: async () => supportedMarketIds.value,
}));

const walletBalances = vi.hoisted(() => new Map<string, bigint>());
vi.mock("@/common/data/rpc/getWalletTokenBalances", () => ({
  getWalletTokenBalances: async () => walletBalances,
}));

// Core REST, served by path. A path with no entry is a 404 (`null`); an `Error` entry is thrown.
const routes = new Map<string, unknown>();
const lists = new Map<string, unknown[] | Error>();
const listCalls: { path: string; query: Record<string, unknown> }[] = [];
const respond = (path: string) => {
  const body = routes.get(path);
  if (body instanceof Error) throw body;
  return body ?? null;
};
vi.mock("@/common/utils/fetchMorphoRest", async (importOriginal) => ({
  MorphoRestError: (await importOriginal<typeof import("@/common/utils/fetchMorphoRest")>()).MorphoRestError,
  fetchMorphoRestResource: async (path: string) => respond(path),
  fetchAllMorphoRestPages: async (path: string, query: Record<string, unknown>) => {
    listCalls.push({ path, query });
    const rows = lists.get(path);
    if (rows instanceof Error) throw rows;
    return rows ?? [];
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
  chunk: <T>(items: readonly T[]) => [items.slice()],
}));

const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ORACLE = "0x0000000000000000000000000000000000000123";
const ZERO = "0x0000000000000000000000000000000000000000";
const vault = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const marketId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const token = (address: string, decimals: number | null, price: number | null) => {
  routes.set(`/v0/tokens/1:${address}`, { data: { decimals } });
  if (price != null) routes.set(`/v0/tokens/1:${address}/price`, { data: { price } });
};

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  routes.clear();
  lists.clear();
  listCalls.length = 0;
  walletBalances.clear();
});

describe("getVaultPositions", () => {
  async function load() {
    const { getVaultPositions } = await import("@/modules/vault/data/getVaultPositions");
    return getVaultPositions(ACCOUNT);
  }

  beforeEach(() => {
    CONFIG.supportedVaults = {
      1: [
        { address: vault(1), protocol: Erc4626VaultProtocol.MorphoV2 },
        { address: vault(2), protocol: Erc4626VaultProtocol.MorphoV2 },
        { address: vault(3), protocol: Erc4626VaultProtocol.MorphoV1 },
      ],
    };
    routes.set(`/v0/vaults-v2/1:${vault(1)}`, { data: { asset: { address: USDC, decimals: 6 } } });
    routes.set(`/v0/vaults-v1/1:${vault(3)}`, { data: { asset: { address: WETH, decimals: 18 } } });
    routes.set(`/v0/tokens/1:${USDC}/price`, { data: { price: 2 } });
    lists.set(`/v0/vaults-v2/users/${ACCOUNT}/positions`, [
      { chain_id: 1, vault_address: vault(1), shares: "1", assets: "2500000" },
    ]);
    walletBalances.set(USDC.toLowerCase(), 1_000_000n);
  });

  it("maps positions onto the provider shape, pricing USD from the asset", async () => {
    const positions = await load();

    expect(positions[1][vault(1) as never]).toEqual({
      vault: { chain: { id: 1 }, asset: { priceUsd: 2 }, vaultAddress: vault(1) },
      assets: { raw: "2500000", formatted: "2.5", usd: 5 },
      walletAssetHolding: { balance: { raw: "1000000", formatted: "1", usd: 2 } },
    });
  });

  it("filters each protocol's positions to its configured vaults", async () => {
    await load();

    expect(listCalls).toEqual([
      {
        path: `/v0/vaults-v2/users/${ACCOUNT}/positions`,
        query: { chain_ids: [1], vault_addresses: [vault(1), vault(2)] },
      },
      { path: `/v0/vaults-v1/users/${ACCOUNT}/positions`, query: { chain_ids: [1], vault_addresses: [vault(3)] } },
    ]);
  });

  it("skips a configured vault the API does not know, and zeroes one without a position", async () => {
    const positions = await load();

    expect(Object.keys(positions[1])).toEqual([vault(1), vault(3)]);
    expect(positions[1][vault(3) as never]).toMatchObject({
      vault: { asset: { priceUsd: null } },
      assets: { raw: "0", formatted: "0", usd: null },
      walletAssetHolding: null,
    });
  });

  it("skips a vault whose asset decimals are not a valid uint8", async () => {
    routes.set(`/v0/vaults-v2/1:${vault(1)}`, { data: { asset: { address: USDC, decimals: null } } });

    const positions = await load();

    expect(Object.keys(positions[1])).toEqual([vault(3)]);
  });

  it("falls back to the token's decimals when the vault root serves none", async () => {
    routes.set(`/v0/vaults-v2/1:${vault(1)}`, { data: { asset: { address: USDC, decimals: null } } });
    routes.set(`/v0/tokens/1:${USDC}`, { data: { decimals: 6 } });

    const positions = await load();

    expect(positions[1]).toMatchObject({ [vault(1)]: { assets: { raw: "2500000", formatted: "2.5", usd: 5 } } });
  });

  it("degrades a failed price read to no USD value", async () => {
    routes.set(`/v0/tokens/1:${USDC}/price`, new Error("Morpho REST 500"));

    const positions = await load();

    expect(positions[1][vault(1) as never]).toMatchObject({
      vault: { asset: { priceUsd: null } },
      assets: { raw: "2500000", usd: null },
    });
  });

  it("degrades a rate-limited price read to no USD value rather than failing the positions", async () => {
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(`/v0/tokens/1:${USDC}/price`, new MorphoRestError(429, "/price", "Too Many Requests"));

    const positions = await load();

    expect(positions[1]).toMatchObject({ [vault(1)]: { assets: { raw: "2500000", usd: null } } });
  });

  it("fails when the position list fails", async () => {
    lists.set(`/v0/vaults-v2/users/${ACCOUNT}/positions`, new Error("Morpho REST 500") as never);

    await expect(load()).rejects.toThrow("Morpho REST 500");
  });
});

describe("getMarketPositions", () => {
  async function load() {
    const { getMarketPositions } = await import("@/modules/market/data/getMarketPositions");
    return getMarketPositions(ACCOUNT);
  }

  beforeEach(() => {
    supportedMarketIds.value = { 1: [marketId(1), marketId(2), marketId(3)] };
    // Market roots come in one batched list; marketId(3) is unknown to the API, so not in it.
    lists.set("/v0/blue/markets", [
      // An idle market: no collateral token, no oracle. Listed first: the API sorts by id.
      { chain_id: 1, market_id: marketId(2), loan_token: USDC, collateral_token: ZERO, oracle_address: ZERO },
      { chain_id: 1, market_id: marketId(1), loan_token: USDC, collateral_token: WETH, oracle_address: ORACLE },
    ]);
    routes.set(`/v0/blue/markets/1:${marketId(1)}/state`, {
      data: { total_borrow_assets: "1000000000", total_borrow_shares: "1000000000000000" },
    });
    // 3,000 USDC per WETH, scaled by 1e36 and the decimals gap.
    routes.set(`/v0/oracles/1:${ORACLE}/state`, { data: { price: "3000000000000000000000000000" } });
    token(USDC, 6, 1);
    token(WETH, 18, 3000);
    lists.set(`/v0/blue/users/${ACCOUNT}/positions`, [
      {
        chain_id: 1,
        market_id: marketId(1),
        supply_shares: "0",
        borrow_shares: "2000000000000",
        collateral_assets: "1000000000000000000",
      },
    ]);
  });

  it("derives borrow assets from shares and LTV from the oracle value of the collateral", async () => {
    walletBalances.set(WETH.toLowerCase(), 500_000_000_000_000_000n);

    const positions = await load();

    expect(positions[1][marketId(1) as never]).toEqual({
      market: { chain: { id: 1 }, marketId: marketId(1) },
      collateralAmount: { raw: "1000000000000000000", formatted: "1", usd: 3000 },
      borrowAmount: { raw: "2000000", formatted: "2", usd: 2 },
      ltv: { raw: "666666666666667", formatted: "0.000666666666666667" },
      walletLoanAssetHolding: null,
      walletCollateralAssetHolding: { balance: { raw: "500000000000000000", formatted: "0.5", usd: 1500 } },
    });
  });

  it("filters positions to the supported markets and reads their roots in one batch", async () => {
    await load();

    expect(listCalls).toEqual([
      {
        path: `/v0/blue/users/${ACCOUNT}/positions`,
        query: { chain_ids: [1], market_ids: [marketId(1), marketId(2), marketId(3)] },
      },
      { path: "/v0/blue/markets", query: { chain_id: [1], market_id: [marketId(1), marketId(2), marketId(3)] } },
    ]);
  });

  it("zeroes a supported market without a position and skips one the API does not know", async () => {
    const positions = await load();

    expect(Object.keys(positions[1])).toEqual([marketId(1), marketId(2)]);
    expect(positions[1][marketId(2) as never]).toMatchObject({
      collateralAmount: { raw: "0", usd: null },
      borrowAmount: { raw: "0", usd: 0 },
      ltv: { raw: "0" },
    });
  });

  it("skips a market whose collateral decimals are unknown instead of assuming 0", async () => {
    token(WETH, null, 3000);

    const positions = await load();

    expect(Object.keys(positions[1])).toEqual([marketId(2)]);
  });

  it("degrades a rate-limited price read to no USD value rather than failing the positions", async () => {
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(`/v0/tokens/1:${WETH}/price`, new MorphoRestError(429, "/price", "Too Many Requests"));

    const positions = await load();

    expect(positions[1]).toMatchObject({
      [marketId(1)]: { collateralAmount: { raw: "1000000000000000000", usd: null }, borrowAmount: { usd: 2 } },
    });
  });

  it("fails when the market list fails", async () => {
    lists.set("/v0/blue/markets", new Error("Morpho REST 404"));

    await expect(load()).rejects.toThrow("Morpho REST 404");
  });

  it("returns no chain when nothing is supported", async () => {
    supportedMarketIds.value = { 1: [] };

    expect(await load()).toEqual({});
    expect(listCalls).toEqual([]);
  });
});
