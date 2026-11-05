import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";

vi.mock("server-only", () => ({}));
vi.mock("@/common/utils/trackEvent", () => ({ trackEvent: () => Promise.resolve() }));

const MARKET = "0x000000000000000000000000000000000000000000000000000000000000beef";
// Configured mainnet vaults in the demo config.
const VAULT_V1 = getAddress("0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB");
const VAULT_V2 = getAddress("0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757");
// Vaults V2 the app does not configure.
const OTHER_V2 = getAddress("0x00000000000000000000000000000000000000b1");
const NEXT_PAGE_V2 = getAddress("0x00000000000000000000000000000000000000b2");
// Supplies the market but Morpho does not list it.
const NOT_LISTED_V2 = getAddress("0x00000000000000000000000000000000000000b3");
const CURATOR = getAddress("0x00000000000000000000000000000000000000a3");
const OTHER_CURATOR = getAddress("0x00000000000000000000000000000000000000a5");
const LOAN = getAddress("0x00000000000000000000000000000000000000c1");
const INTERNAL_HOST = "https://internal.example";
const ROUTE = `/v0/blueprint-app-api/blue/markets/1:${MARKET}/supplying-vaults`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Keyed by host + path (+ `?cursor=` for list pages). Anything else is a missing resource.
const routes = new Map<string, unknown>();
const calls: string[] = [];
const fetchMock = vi.fn(async (input: URL) => {
  const url = new URL(input);
  const cursor = url.searchParams.get("cursor");
  const key = `${url.origin}${url.pathname}${cursor ? `?cursor=${cursor}` : ""}`;
  calls.push(key);
  if (routes.has(key)) return json(200, routes.get(key));
  return json(404, { statusCode: 404, message: "not found", error: "Not Found" });
});

const core = (path: string) => `https://api.morpho.org${path}`;

function v2Allocations(supplyAssets: string, cap: string) {
  return {
    data: {
      allocations: [
        {
          caps: [
            {
              cap_type: "market_v1",
              market_id: MARKET,
              allocated_assets: supplyAssets,
              absolute_cap: cap,
              expected_supply_assets: supplyAssets,
            },
          ],
        },
      ],
    },
  };
}

function routeRow(address: string, supplyAssets: string) {
  return { chain_id: 1, vault_address: address, supply_assets: supplyAssets, last_indexed_block: "1" };
}

function seed() {
  routes.set(core(`/v0/vaults-v1/1:${VAULT_V1}/allocations`), {
    data: {
      allocations: [{ market_id: MARKET, supply_assets: "300", supply_shares: "300000", supply_cap: "500" }],
    },
  });
  routes.set(core(`/v0/vaults-v1/1:${VAULT_V1}`), { data: { name: "Steakhouse USDC", curator: CURATOR, owner: null } });
  routes.set(core(`/v0/vaults-v2/1:${VAULT_V2}/allocations`), v2Allocations("150", "300"));
  routes.set(core(`/v0/vaults-v2/1:${VAULT_V2}`), {
    data: { name: "Steakhouse High Yield", curator: null, owner: null },
  });
  routes.set(core(`/v0/vaults-v2/1:${OTHER_V2}/allocations`), v2Allocations("70", "100"));
  routes.set(core(`/v0/vaults-v2/1:${NEXT_PAGE_V2}/allocations`), v2Allocations("20", "50"));
  routes.set(core(`/v0/vaults-v2/1:${NOT_LISTED_V2}/allocations`), v2Allocations("1", "50"));
  // Names and curators of the vaults V2 the app does not configure: one list of the loan token's.
  routes.set(core("/v0/vaults-v2"), {
    data: [
      { vault_address: OTHER_V2, name: "Other Prime", curator: OTHER_CURATOR },
      { vault_address: NEXT_PAGE_V2, name: null, curator: null },
      { vault_address: getAddress("0x00000000000000000000000000000000000000b9"), name: "Unrelated", curator: null },
    ],
    cursor: null,
  });
  routes.set(core("/v0/curators"), {
    data: [
      {
        name: "Other Labs",
        image_url: "https://other",
        addresses: [
          { chain_id: 8453, curator_address: CURATOR },
          { chain_id: 1, curator_address: OTHER_CURATOR },
        ],
      },
    ],
    cursor: null,
  });
  routes.set(core(`/v0/curators/1:${CURATOR}/details`), {
    data: { curators: [{ name: "Steakhouse", logo_uri: null, socials: [] }] },
  });
  // Two pages: the configured vault V2 and one other on the first, another on the second.
  routes.set(`${INTERNAL_HOST}${ROUTE}`, {
    data: [routeRow(VAULT_V2, "150"), routeRow(OTHER_V2, "70")],
    cursor: "page-2",
  });
  routes.set(`${INTERNAL_HOST}${ROUTE}?cursor=page-2`, {
    data: [routeRow(NEXT_PAGE_V2, "20"), routeRow(NOT_LISTED_V2, "1")],
    cursor: null,
  });
}

async function load() {
  const { getMarketSupplyingVaults } = await import("@/modules/market/data/getMarketSupplyingVaults");
  const rows = await getMarketSupplyingVaults(1, MARKET, LOAN);
  return new Map(rows.map((row) => [row.vaultAddress, row]));
}

describe("getMarketSupplyingVaults", () => {
  beforeEach(() => {
    vi.resetModules();
    routes.clear();
    calls.length = 0;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MORPHO_API_URL", "");
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_KEY", "");
    vi.stubEnv("MORPHO_INTERNAL_API_URL", INTERNAL_HOST);
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    seed();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("lists only the configured vaults without the Blueprint key", async () => {
    const rows = await load();
    expect([...rows.keys()].sort()).toEqual([VAULT_V1, VAULT_V2].sort());
    expect([...rows.values()].every((row) => row.configured)).toBe(true);
    expect(calls.some((key) => key.startsWith(INTERNAL_HOST))).toBe(false);
  });

  it("adds every vault V2 the Blueprint API lists, across its pages, composed from Core", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    const rows = await load();
    expect([...rows.keys()].sort()).toEqual([VAULT_V1, VAULT_V2, OTHER_V2, NEXT_PAGE_V2].sort());

    expect(rows.get(VAULT_V1)).toMatchObject({ protocol: Erc4626VaultProtocol.MorphoV1, configured: true });
    expect(rows.get(VAULT_V2)).toMatchObject({ configured: true, supplyAssets: 150n, supplyCap: 300n });
    expect(rows.get(OTHER_V2)).toMatchObject({
      protocol: Erc4626VaultProtocol.MorphoV2,
      configured: false,
      name: "Other Prime",
      curatorAddress: OTHER_CURATOR,
      supplyAssets: 70n,
      supplyCap: 100n,
      supplyShares: "0",
    });
    expect(rows.get(OTHER_V2)?.curator).toEqual({ name: "Other Labs", image: "https://other", url: null });
    // No name in Core: the address stands in.
    expect(rows.get(NEXT_PAGE_V2)).toMatchObject({ configured: false, name: NEXT_PAGE_V2, curator: null });

    expect(calls.filter((key) => key.startsWith(INTERNAL_HOST))).toEqual([
      `${INTERNAL_HOST}${ROUTE}`,
      `${INTERNAL_HOST}${ROUTE}?cursor=page-2`,
    ]);
    // The configured vault V2 the route also lists is read once.
    expect(calls.filter((key) => key === core(`/v0/vaults-v2/1:${VAULT_V2}/allocations`))).toHaveLength(1);
    // A vault Morpho does not list is left out, unread.
    expect(rows.has(NOT_LISTED_V2)).toBe(false);
    expect(calls).not.toContain(core(`/v0/vaults-v2/1:${NOT_LISTED_V2}/allocations`));
    // The other vaults' names and curators come from the two lists, not a read per vault.
    expect(calls).not.toContain(core(`/v0/vaults-v2/1:${OTHER_V2}`));
    expect(calls).not.toContain(core(`/v0/curators/1:${OTHER_CURATOR}/details`));
    const list = fetchMock.mock.calls.map(([input]) => new URL(input)).find((url) => url.pathname === "/v0/vaults-v2");
    expect(list?.searchParams.get("chain_ids")).toBe("1");
    expect(list?.searchParams.get("asset_addresses")).toBe(LOAN);
  });

  it("keeps the configured vaults only when the vault list fails", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    routes.delete(core("/v0/vaults-v2"));
    const rows = await load();
    expect([...rows.keys()].sort()).toEqual([VAULT_V1, VAULT_V2].sort());
    expect(calls).not.toContain(core(`/v0/vaults-v2/1:${OTHER_V2}/allocations`));
  });

  it("serves another vault's curator as unknown when the curator list fails", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    routes.delete(core("/v0/curators"));
    const rows = await load();
    expect(rows.get(OTHER_V2)).toMatchObject({ curatorAddress: OTHER_CURATOR, curator: null, supplyAssets: 70n });
  });

  it("keeps the configured vaults when the Blueprint read fails", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    routes.delete(`${INTERNAL_HOST}${ROUTE}`);
    const rows = await load();
    expect([...rows.keys()].sort()).toEqual([VAULT_V1, VAULT_V2].sort());
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("using the fallback"));
  });

  it("leaves out a vault V2 the route lists but Core does not know", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    routes.delete(core(`/v0/vaults-v2/1:${OTHER_V2}/allocations`));
    const rows = await load();
    expect(rows.has(OTHER_V2)).toBe(false);
    expect(rows.has(NEXT_PAGE_V2)).toBe(true);
  });
});
