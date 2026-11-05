import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

// The module under test is server-only and wraps its resolver in Next/React caches. Neutralize all
// three so the whitelist logic can be driven directly.
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

// Allocations served per `<chain>:<vault>` selector; anything else is a 404 (`null`).
const allocations = new Map<string, unknown[]>();
const fetchMorphoRest = vi.fn(async (path: string) => {
  const [, , kind, selector] = path.split("/");
  const rows = allocations.get(`${kind}/${selector?.toLowerCase()}`);
  return rows ? { data: { allocations: rows } } : null;
});
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: (path: string) => fetchMorphoRest(path),
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
}));

const marketId = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const vault = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const marketV1Cap = (n: number, { absolute = "1000", allocated = "0" } = {}) => ({
  cap_type: "market_v1",
  market_id: marketId(n),
  absolute_cap: absolute,
  allocated_assets: allocated,
});
const marketAdapter = (...caps: ReturnType<typeof marketV1Cap>[]) => ({ caps, target: { type: "blue_market" } });
const vaultAdapter = (type: "vault_v1" | "vault_v2", address: string) => ({
  caps: [{ cap_type: "adapter" }],
  target: { type, vault_address: address },
});
const v1Allocation = (n: number) => ({ market_id: marketId(n) });

const serve = (kind: "vaults-v1" | "vaults-v2", chainId: number, address: string, rows: unknown[]) =>
  allocations.set(`${kind}/${chainId}:${address.toLowerCase()}`, rows);

async function loadWhitelist() {
  const { getSupportedMarketIds } = await import("@/modules/market/data/getSupportedMarketIds");
  return getSupportedMarketIds();
}

describe("getSupportedMarketIds", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    allocations.clear();
    fetchMorphoRest.mockClear();
    CONFIG.supportedVaults = { 1: [{ address: vault(1), protocol: Erc4626VaultProtocol.MorphoV2 }] };
  });

  it("unions a vault V2's MarketV1 caps with its vault V1 adapter's allocations", async () => {
    serve("vaults-v2", 1, vault(1), [
      marketAdapter(marketV1Cap(1), marketV1Cap(2)),
      vaultAdapter("vault_v1", vault(9)),
    ]);
    serve("vaults-v1", 1, vault(9), [v1Allocation(2), v1Allocation(3)]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1), marketId(2), marketId(3)] });
  });

  it("drops a zeroed cap with nothing allocated, but keeps one still holding assets", async () => {
    serve("vaults-v2", 1, vault(1), [
      marketAdapter(
        marketV1Cap(1),
        marketV1Cap(2, { absolute: "0" }),
        marketV1Cap(3, { absolute: "0", allocated: "5" }),
      ),
    ]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1), marketId(3)] });
  });

  it("reads configured vault V1s and keys markets by chain", async () => {
    CONFIG.supportedVaults = {
      1: [{ address: vault(1), protocol: Erc4626VaultProtocol.MorphoV2 }],
      8453: [{ address: vault(2), protocol: Erc4626VaultProtocol.MorphoV1 }],
    };
    serve("vaults-v2", 1, vault(1), [marketAdapter(marketV1Cap(1))]);
    serve("vaults-v1", 8453, vault(2), [v1Allocation(7)]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1)], 8453: [marketId(7)] });
  });

  it("skips a configured vault the API does not know", async () => {
    CONFIG.supportedVaults = {
      1: [
        { address: vault(1), protocol: Erc4626VaultProtocol.MorphoV2 },
        { address: vault(2), protocol: Erc4626VaultProtocol.MorphoV2 },
      ],
    };
    serve("vaults-v2", 1, vault(1), [marketAdapter(marketV1Cap(1))]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1)] });
  });

  it("ignores adapters whose target it does not know", async () => {
    serve("vaults-v2", 1, vault(1), [
      marketAdapter(marketV1Cap(1)),
      { caps: [{ cap_type: "adapter" }], target: { type: "unknown", target_address: vault(5) } },
    ]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1)] });
  });

  it("follows a vault V2 adapter into the inner vault's markets", async () => {
    serve("vaults-v2", 1, vault(1), [vaultAdapter("vault_v2", vault(2))]);
    serve("vaults-v2", 1, vault(2), [marketAdapter(marketV1Cap(4))]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(4)] });
  });

  it("stops walking when adapters point back at a vault already visited", async () => {
    serve("vaults-v2", 1, vault(1), [marketAdapter(marketV1Cap(1)), vaultAdapter("vault_v2", vault(2))]);
    serve("vaults-v2", 1, vault(2), [marketAdapter(marketV1Cap(2)), vaultAdapter("vault_v2", vault(1))]);

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1), marketId(2)] });
    expect(fetchMorphoRest).toHaveBeenCalledTimes(2);
  });

  it("bounds the walk when vaults nest deeper than the adapter depth limit", async () => {
    for (let n = 1; n <= 5; n++) {
      serve("vaults-v2", 1, vault(n), [marketAdapter(marketV1Cap(n)), vaultAdapter("vault_v2", vault(n + 1))]);
    }

    expect(await loadWhitelist()).toEqual({ 1: [marketId(1), marketId(2), marketId(3)] });
    expect(fetchMorphoRest).toHaveBeenCalledTimes(3);
  });

  it("fails rather than serving a partial whitelist when a read errors", async () => {
    fetchMorphoRest.mockRejectedValueOnce(new Error("Morpho REST 500"));

    await expect(loadWhitelist()).rejects.toThrow("Morpho REST 500");
  });
});
