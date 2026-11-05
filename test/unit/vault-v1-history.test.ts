import { beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));

// Vault V1 details still come from GraphQL; only the history moved to REST.
vi.mock("@/common/utils/executeMorphoQuery", () => ({
  executeMorphoQuery: async () => ({ vaults: { items: [{ asset: { decimals: 6 } }] } }),
}));
vi.mock("@/modules/vault/data/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/vault/data/adapters")>()),
  toMorphoVaultV1Details: () => ({}),
}));
vi.mock("@/modules/vault/utils/normalizeVault", () => ({ normalizeVault: <T>(vault: T) => vault }));

const routes = new Map<string, unknown>();
const calls: { path: string; query: unknown }[] = [];
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string, query: { lookback: string }) => {
    calls.push({ path, query });
    return routes.get(`${path}?${query.lookback}`) ?? null;
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
}));

const VAULT = "0x0000000000000000000000000000000000000001";
const BASE = `/v0/vaults-v1/1:${VAULT}`;

async function loadHistory() {
  const { getVault } = await import("@/modules/vault/data/getVault");
  const vault = await getVault(1, VAULT, Erc4626VaultProtocol.MorphoV1);
  return vault.historical;
}

describe("getVault (Vault V1 history)", () => {
  beforeEach(() => {
    vi.resetModules();
    routes.clear();
    calls.length = 0;
  });

  it("requests one REST lookback per chart resolution", async () => {
    await loadHistory();

    expect(calls.map(({ path, query }) => `${path.replace(BASE, "")} ${JSON.stringify(query)}`).sort()).toEqual([
      '/apy/history {"lookback":"inception"}',
      '/apy/history {"lookback":"ninety_days"}',
      '/apy/history {"lookback":"seven_days"}',
      '/state/history {"lookback":"inception"}',
      '/state/history {"lookback":"ninety_days"}',
      '/state/history {"lookback":"seven_days"}',
    ]);
  });

  it("zips total assets and net APY into chart entries, with no USD series", async () => {
    routes.set(`${BASE}/state/history?seven_days`, {
      data: [
        { timestamp: 100, total_assets: "1500000" },
        { timestamp: 200, total_assets: "2000000" },
      ],
    });
    routes.set(`${BASE}/apy/history?seven_days`, {
      data: [
        { timestamp: 100, apy: 0.04 },
        { timestamp: 200, apy: 0.05 },
      ],
    });

    const historical = await loadHistory();

    expect(historical?.hourly).toEqual([
      { bucketTimestamp: 100, totalSupplied: { formatted: "1.5", usd: null }, netApy: { total: 0.04 } },
      { bucketTimestamp: 200, totalSupplied: { formatted: "2", usd: null }, netApy: { total: 0.05 } },
    ]);
  });

  it("leaves a resolution empty when the vault is missing from REST", async () => {
    const historical = await loadHistory();

    expect(historical).toEqual({ hourly: [], daily: [], weekly: [] });
  });
});
