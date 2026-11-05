import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

type ConfiguredVaults = Record<number, { address: string; protocol: string; description?: string }[]>;
const CONFIG = vi.hoisted(() => {
  const supportedVaults: ConfiguredVaults = {};
  return { apyWindow: "6h", chainConfig: { 1: { chain: { name: "Ethereum" }, iconSlug: "eth" } }, supportedVaults };
});
vi.mock("@/config", () => ({ APP_CONFIG: CONFIG }));

const blueprint = vi.hoisted(() => ({ enabled: false }));
vi.mock("@/common/utils/morphoApiConfig", () => ({ isBlueprintApiEnabled: () => blueprint.enabled }));

// Core REST, served by path plus query. A missing entry is a 404 (`null`); an `Error` is thrown.
const routes = new Map<string, unknown>();
const lists = new Map<string, unknown[] | Error>();
const calls: { path: string; query?: Record<string, unknown>; api?: string }[] = [];
const key = (path: string, query?: Record<string, unknown>) =>
  query ? `${path}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}` : path;
const respond = (path: string, query?: Record<string, unknown>) => {
  calls.push({ path, query });
  const body = routes.get(key(path, query));
  if (body instanceof Error) throw body;
  return body ?? null;
};
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRest: async (path: string, query?: Record<string, unknown>) => {
    const body = respond(path, query);
    if (body === null) throw new Error(`Morpho REST 404 on ${path}`);
    return body;
  },
  fetchMorphoRestResource: async (path: string, query?: Record<string, unknown>) => respond(path, query),
  fetchAllMorphoRestPages: async (path: string, query: Record<string, unknown>, options?: { api?: string }) => {
    calls.push({ path, query, api: options?.api });
    const rows = lists.get(path);
    if (rows instanceof Error) throw rows;
    return rows ?? [];
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
  chunk: <T>(items: readonly T[]) => [items.slice()],
}));

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CURATOR = "0x827e86072B06674a077f592A531dcE4590aDeCdB";
const ZERO = "0x0000000000000000000000000000000000000000";
const vault = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const MORPHO_TOKEN = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";

// Merkl, behind the real reward index (React `cache` is a no-op here, as outside a render): each
// request is counted, and `down` makes every one fail.
const merkl = vi.hoisted((): { opportunities: unknown[]; down: boolean; requests: number; reports: string[] } => ({
  opportunities: [],
  down: false,
  requests: 0,
  reports: [],
}));
vi.mock("@/common/utils/fetch", () => ({
  fetchJsonResponse: async () => {
    merkl.requests += 1;
    if (merkl.down) throw new Error("Fetch failed");
    return merkl.opportunities;
  },
}));
vi.mock("@/common/utils/trackEvent", () => ({
  trackEvent: async (event: string) => {
    merkl.reports.push(event);
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

function restVault(
  n: number,
  {
    curator = CURATOR,
    totalAssets = "2500000",
    apy,
  }: { curator?: string; totalAssets?: string; apy?: number | null } = {},
) {
  routes.set(`/v0/vaults-v2/1:${vault(n)}`, {
    data: {
      chain_id: 1,
      address: vault(n),
      name: `Vault ${n}`,
      asset: { address: USDC, decimals: 6, name: "USDCoin", symbol: "USDC" },
      curator,
    },
  });
  routes.set(`/v1/vaults-v2/1:${vault(n)}/state`, { data: { total_assets: totalAssets, idle_assets: "0" } });
  routes.set(key(`/v1/vaults-v2/1:${vault(n)}/apy-averages`, { lookback: "six_hours" }), {
    data: { lookback: "six_hours", apy: apy === undefined ? 0.05 : apy },
  });
}

async function load() {
  const { getVaultSummaries } = await import("@/modules/vault/data/getVaultSummaries");
  return getVaultSummaries();
}

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  routes.clear();
  lists.clear();
  calls.length = 0;
  merkl.opportunities = [];
  merkl.down = false;
  merkl.requests = 0;
  merkl.reports.length = 0;
  blueprint.enabled = false;
  CONFIG.supportedVaults = {
    1: [
      { address: vault(1), protocol: Erc4626VaultProtocol.MorphoV2 },
      { address: vault(2), protocol: Erc4626VaultProtocol.MorphoV2, description: "From config" },
    ],
  };
  restVault(1);
  restVault(2, { curator: ZERO, apy: null });
  routes.set(`/v0/tokens/1:${USDC}`, {
    data: {
      address: USDC,
      name: "USDCoin",
      symbol: "USDC",
      decimals: 6,
      logo_uri: "https://cdn/usdc.svg",
      tags: ["stablecoin", "simple-permit"],
    },
  });
  routes.set(`/v0/tokens/1:${USDC}/price`, { data: { price: 2 } });
  routes.set(`/v0/curators/1:${CURATOR}/details`, {
    data: {
      curators: [
        {
          name: "Steakhouse Financial",
          logo_uri: "https://cdn/steakhouse.svg",
          socials: [
            { type: "twitter", url: "https://x.com/SteakhouseFi" },
            { type: "url", url: "https://www.steakhouse.financial" },
          ],
        },
      ],
    },
  });
});

describe("getVaultSummaries (vault V2 from Core REST)", () => {
  it("maps the root, state, APY window, token and curator onto the provider shape", async () => {
    const [summary] = await load();

    expect(summary).toEqual({
      __typename: "MorphoVaultV2",
      chain: { id: 1, name: "Ethereum", icon: "https://cdn.morpho.org/assets/chains/eth.svg" },
      vaultAddress: vault(1),
      name: "Vault 1",
      asset: {
        address: USDC,
        symbol: "USDC",
        name: "USDCoin",
        decimals: 6,
        icon: "https://cdn/usdc.svg",
        // The template maps asset-class tags onto display categories.
        category: "Stable",
        priceUsd: 2,
      },
      totalAssets: { raw: "2500000", formatted: "2.5", usd: 5 },
      apy: { afterFees: 0.05, total: 0.05, rewards: [] },
      metadata: {
        description: null,
        curator: {
          name: "Steakhouse Financial",
          image: "https://cdn/steakhouse.svg",
          url: "https://www.steakhouse.financial",
        },
      },
      curatorAum: undefined,
      allocations: [],
      isHidden: false,
    });
  });

  it("reads each token and curator once", async () => {
    restVault(2);

    await load();

    const paths = calls.map((call) => call.path);
    expect(paths.filter((path) => path === `/v0/tokens/1:${USDC}`)).toHaveLength(1);
    expect(paths.filter((path) => path === `/v0/tokens/1:${USDC}/price`)).toHaveLength(1);
    expect(paths.filter((path) => path === `/v0/curators/1:${CURATOR}/details`)).toHaveLength(1);
  });

  it("uses the config description and no curator when the vault has none and the Blueprint API is off", async () => {
    const [, second] = await load();

    expect(second?.metadata).toEqual({ description: "From config", curator: null });
    expect(second?.apy).toEqual({ afterFees: 0, total: 0, rewards: [] });
    expect(calls.some((call) => call.path.includes("/curators/1:0x0000"))).toBe(false);
    expect(calls.some((call) => call.path.includes("blueprint-app-api"))).toBe(false);
  });

  it("reads descriptions from the Blueprint API metadata route when it is on", async () => {
    blueprint.enabled = true;
    lists.set("/v0/blueprint-app-api/vaults-v2/metadata", [
      { chain_id: 1, vault_address: vault(1), description: "Curated description" },
      { chain_id: 1, vault_address: vault(2), description: null },
    ]);

    const [first, second] = await load();

    expect(calls.find((call) => call.path === "/v0/blueprint-app-api/vaults-v2/metadata")).toEqual({
      path: "/v0/blueprint-app-api/vaults-v2/metadata",
      query: { vaults: [`1:${vault(1)}`, `1:${vault(2)}`] },
      api: "blueprint",
    });
    expect(first?.metadata?.description).toBe("Curated description");
    expect(second?.metadata?.description).toBe("From config");
  });

  it("falls back to the config description when the metadata route fails", async () => {
    blueprint.enabled = true;
    lists.set("/v0/blueprint-app-api/vaults-v2/metadata", new Error("Morpho REST 500"));

    const [first, second] = await load();

    expect(first?.metadata?.description).toBeNull();
    expect(second?.metadata?.description).toBe("From config");
  });

  it("keeps the row without a curator when the curator read fails", async () => {
    routes.set(`/v0/curators/1:${CURATOR}/details`, new Error("Morpho REST 500"));

    const [first] = await load();

    expect(first?.metadata?.curator).toBeNull();
  });

  it("falls back to the root's token fields when token metadata is missing", async () => {
    routes.delete(`/v0/tokens/1:${USDC}`);
    routes.delete(`/v0/tokens/1:${USDC}/price`);

    const [first] = await load();

    expect(first?.asset).toEqual({
      address: USDC,
      symbol: "USDC",
      name: "USDCoin",
      decimals: 6,
      icon: null,
      category: null,
      priceUsd: null,
    });
    expect(first?.totalAssets).toEqual({ raw: "2500000", formatted: "2.5", usd: null });
  });

  describe("null names and symbols (nullable in Core REST)", () => {
    function nullAssetFields(fields: { name?: null; symbol?: null }, vaultName?: null) {
      routes.set(`/v0/tokens/1:${USDC}`, {
        data: { address: USDC, name: "USDCoin", symbol: "USDC", decimals: 6, logo_uri: null, tags: null, ...fields },
      });
      routes.set(`/v0/vaults-v2/1:${vault(1)}`, {
        data: {
          address: vault(1),
          name: vaultName === null ? null : "Vault 1",
          asset: { address: USDC, decimals: 6, name: "USDCoin", symbol: "USDC", ...fields },
          curator: CURATOR,
        },
      });
    }

    it("falls back from a null symbol to the name", async () => {
      nullAssetFields({ symbol: null });

      const [first] = await load();

      expect(first?.asset).toMatchObject({ symbol: "USDCoin", name: "USDCoin" });
    });

    it("falls back to UNKNOWN when both the symbol and the name are null", async () => {
      nullAssetFields({ symbol: null, name: null });

      const [first] = await load();

      expect(first?.asset).toMatchObject({ symbol: "UNKNOWN", name: "UNKNOWN" });
    });

    it("falls back from a null vault name to the vault address", async () => {
      nullAssetFields({}, null);

      const [first] = await load();

      expect(first?.name).toBe(vault(1));
    });
  });

  it("adds the vault's current Merkl reward APRs to its native APY", async () => {
    merkl.opportunities = [{ campaigns: [merklCampaign("ERC20LOGPROCESSOR", 1.5, { targetToken: vault(1) })] }];

    const [first, second] = await load();

    expect(first?.apy).toEqual({ afterFees: 0.05, total: 0.065, rewards: [{ asset: MORPHO_REWARD, apr: 0.015 }] });
    expect(second?.apy).toEqual({ afterFees: 0, total: 0, rewards: [] });
  });

  it("reads Merkl once for three vaults on one chain, and reports one failure when it is down", async () => {
    CONFIG.supportedVaults = {
      1: [1, 2, 3].map((n) => ({ address: vault(n), protocol: Erc4626VaultProtocol.MorphoV2 })),
    };
    restVault(3);
    merkl.down = true;

    const summaries = await load();

    expect(summaries).toHaveLength(3);
    expect(merkl.requests).toBe(1);
    expect(merkl.reports).toEqual(["data-fetch-error"]);
    expect(summaries.map((summary) => summary.apy.rewards)).toEqual([[], [], []]);
  });

  it("drops a vault the API does not know, in config order", async () => {
    routes.delete(`/v0/vaults-v2/1:${vault(1)}`);

    const summaries = await load();

    expect(summaries.map((summary) => summary.vaultAddress)).toEqual([vault(2)]);
    expect(console.warn).toHaveBeenCalledWith(`Vault not returned by the API: 1:${vault(1)}`);
  });

  it("fails when a vault read fails", async () => {
    routes.set(`/v1/vaults-v2/1:${vault(1)}/state`, new Error("Morpho REST 500"));

    await expect(load()).rejects.toThrow("Morpho REST 500");
  });
});
