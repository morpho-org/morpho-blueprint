import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  indexMerklRewards,
  marketBorrowRewardApys,
  marketSupplyRewardApys,
  vaultRewardApys,
} from "@/modules/reward/data/merklRewardApys";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // React's per-render memo, keyed by the arguments; vi.resetModules gives each test a fresh one.
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A) => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key);
    };
  },
}));

interface FetchOptions {
  requestOptions?: { signal?: AbortSignal };
  retryOptionOverrides?: unknown;
  suppressFailureEvent?: boolean;
}
const fetchState = vi.hoisted(
  (): { pages: unknown[]; error: Error | null; hang: boolean; urls: string[]; options: FetchOptions[] } => ({
    pages: [],
    error: null,
    hang: false,
    urls: [],
    options: [],
  }),
);
vi.mock("@/common/utils/fetch", () => ({
  fetchJsonResponse: async (url: URL, options: FetchOptions) => {
    fetchState.urls.push(url.toString());
    fetchState.options.push(options);
    if (fetchState.error) throw fetchState.error;
    // A Merkl that never answers, with the abort signal ignored (Next drops it when revalidating a
    // stale entry): only a deadline outside fetch ends the wait.
    if (fetchState.hang) await new Promise(() => {});
    return fetchState.pages[Number(url.searchParams.get("page"))] ?? [];
  },
}));
interface RestCall {
  path: string;
  options: { revalidate?: number; quiet?: boolean } | undefined;
}
const restState = vi.hoisted(
  (): { tokens: Map<string, unknown>; failing: Set<string>; hanging: Set<string>; calls: RestCall[] } => ({
    tokens: new Map(),
    failing: new Set(),
    hanging: new Set(),
    calls: [],
  }),
);
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string, _query: unknown, options: RestCall["options"]) => {
    restState.calls.push({ path, options });
    if (restState.failing.has(path)) throw new Error("Morpho REST 500");
    if (restState.hanging.has(path)) await new Promise(() => {});
    return restState.tokens.get(path) ?? null;
  },
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
}));
const reports = vi.hoisted((): { event: string; context: unknown }[] => []);
vi.mock("@/common/utils/trackEvent", () => ({
  trackEvent: async (event: string, { chainId }: Record<string, unknown>) => {
    reports.push({ event, context: { chainId } });
  },
}));

const NOW = 1_800_000_000;
const VAULT = getAddress("0x00000000000000000000000000000000000000a1");
const OTHER_VAULT = getAddress("0x00000000000000000000000000000000000000a2");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const MARKET = `0x${"17".repeat(32)}`;
const OTHER_MARKET = `0x${"17".repeat(20)}${"00".repeat(12)}`;
const MORPHO_TOKEN = "0x58D97B57BB95320F9a05dC918Aef65434969c2B2";
const FXN_TOKEN = "0x365AccFCa291e7D3914637ABf1F7635dB165Bb09";

let nextId = 0;
function campaign(overrides: Record<string, unknown> = {}, params: Record<string, unknown> = {}) {
  nextId += 1;
  return {
    id: String(nextId),
    type: "ERC20LOGPROCESSOR",
    subType: 0,
    computeChainId: 1,
    startTimestamp: NOW - 86_400,
    endTimestamp: NOW + 86_400,
    apr: 2,
    isPrivate: false,
    rewardToken: {
      address: MORPHO_TOKEN,
      symbol: "MORPHO",
      name: "Morpho Token",
      decimals: 18,
      icon: "https://merkl/morpho.svg",
      type: "TOKEN",
      isTest: false,
    },
    ...overrides,
    params: { hooks: [], whitelist: [], blacklist: [], targetToken: VAULT, ...params },
  };
}
const opportunities = (...campaigns: unknown[]) => [{ campaigns }];
const MORPHO_ASSET = {
  address: MORPHO_TOKEN,
  symbol: "MORPHO",
  name: "Morpho Token",
  decimals: 18,
  icon: "https://merkl/morpho.svg",
  category: null,
};

describe("indexMerklRewards filters", () => {
  it("keeps a live public token campaign on the vault it targets, APR as a fraction", () => {
    const index = indexMerklRewards(opportunities(campaign()), NOW);

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: 0.02 }]);
    expect(vaultRewardApys(index, OTHER_VAULT, "v2")).toEqual([]);
  });

  it("drops campaigns shorter than a day and rewards paid on a chain the backend does not support", () => {
    const index = indexMerklRewards(
      opportunities(
        campaign({ apr: 1, startTimestamp: NOW - 100, endTimestamp: NOW - 100 + 86_399 }),
        campaign({ apr: 2, rewardToken: { ...campaign().rewardToken, chainId: 56 } }),
        campaign({ apr: 3, computeChainId: 56 }),
        campaign({ apr: 4, startTimestamp: NOW - 100, endTimestamp: NOW - 100 + 86_400, computeChainId: 1 }),
        campaign({ apr: 5, computeChainId: 56, rewardToken: { ...campaign().rewardToken, chainId: 239 } }),
      ),
      NOW,
    );

    // Exactly one day is kept; the reward token's chain wins over the compute chain.
    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.09) }]);
  });

  it("drops private, whitelisted, ended, future, zero-APR, test and non-token campaigns", () => {
    const index = indexMerklRewards(
      opportunities(
        campaign({ isPrivate: true }),
        campaign({}, { whitelist: ["0x00000000000000000000000000000000000000ff"] }),
        campaign({ endTimestamp: NOW }),
        campaign({ startTimestamp: NOW + 1 }),
        campaign({ apr: 0 }),
        campaign({ rewardToken: { ...campaign().rewardToken, isTest: true } }),
        campaign({ rewardToken: { ...campaign().rewardToken, type: "POINT" } }),
      ),
      NOW,
    );

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([]);
  });

  it("ignores the blacklist hook, skips unknown hooks, and keeps hook-23 campaigns for vault V2s only", () => {
    const vaultV2Hook = { hookType: 23, protocols: ["MorphoVaultV2"] };
    const index = indexMerklRewards(
      opportunities(
        campaign({ apr: 1 }, { hooks: [{ hookType: 27 }] }),
        campaign({ apr: 3 }, { hooks: [{ hookType: 9 }] }),
        campaign({ apr: 4 }, { hooks: [{ hookType: 23, protocols: ["MorphoVaultV1"] }] }),
        campaign({ apr: 5 }, { hooks: [vaultV2Hook] }),
      ),
      NOW,
    );

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.06) }]);
    expect(vaultRewardApys(index, VAULT, "v1")).toEqual([{ asset: MORPHO_ASSET, apr: 0.01 }]);
  });

  it("sums campaigns per reward token and drops a malformed campaign alone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fxn = { ...campaign().rewardToken, address: FXN_TOKEN, symbol: "FXN", name: "FXN Token", icon: null };
    const index = indexMerklRewards(
      opportunities(campaign({ apr: 1 }), campaign({ apr: 2.5 }), campaign({ rewardToken: fxn }), { id: "broken" }),
      NOW,
    );

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([
      { asset: MORPHO_ASSET, apr: expect.closeTo(0.035) },
      { asset: { ...MORPHO_ASSET, address: FXN_TOKEN, symbol: "FXN", name: "FXN Token", icon: null }, apr: 0.02 },
    ]);
  });
});

describe("indexMerklRewards hardening", () => {
  it("drops a campaign whose reward token address has a bad checksum, as the rewards backend does", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const badChecksum = MORPHO_TOKEN.replace("D97B", "d97b");
    const index = indexMerklRewards(
      opportunities(
        campaign({ apr: 1, rewardToken: { ...campaign().rewardToken, address: badChecksum } }),
        campaign({ apr: 2, rewardToken: { ...campaign().rewardToken, address: MORPHO_TOKEN.toLowerCase() } }),
      ),
      NOW,
    );

    // A lowercase address carries no checksum and is kept.
    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: 0.02 }]);
  });

  it("drops and warns about a campaign above 1000% APR, and the schema rejects a non-finite one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const index = indexMerklRewards(
      opportunities(
        campaign({ id: "huge", apr: 1000.5 }),
        campaign({ id: "infinite", apr: Number.POSITIVE_INFINITY }),
        campaign({ id: "cap", apr: 1000 }),
      ),
      NOW,
    );

    // Exactly 1000% is kept.
    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: 10 }]);
    expect(warn.mock.calls.map(([message]) => String(message).split("\n")[0])).toEqual([
      "Dropping Merkl campaign huge: APR 1000.5% is above the sanity cap",
      "Dropping invalid Merkl campaign: ✖ Invalid input: expected number, received Infinity",
    ]);
  });

  it("applies the checksum rule and the APR cap to borrow campaigns too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badChecksum = MORPHO_TOKEN.replace("D97B", "d97b");
    const index = indexMerklRewards(
      opportunities(
        campaign({ id: "huge-borrow", type: "MORPHOBORROW", apr: 1000.5 }, { market: MARKET }),
        campaign(
          { type: "MORPHOBORROW", apr: 1, rewardToken: { ...campaign().rewardToken, address: badChecksum } },
          { market: MARKET },
        ),
        campaign({ type: "MORPHOBORROW", apr: 3 }, { market: MARKET }),
      ),
      NOW,
    );

    expect(marketBorrowRewardApys(index, MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: 0.03 }]);
    expect(warn.mock.calls.map(([message]) => String(message).split("\n")[0])).toContain(
      "Dropping Merkl campaign huge-borrow: APR 1000.5% is above the sanity cap",
    );
  });
});

describe("pass-through and market rewards", () => {
  it("credits a vault with the child campaign Merkl forwards it from a market campaign", () => {
    const parent = campaign({ type: "MORPHOSUPPLY", apr: 5.6 }, { market: MARKET, targetToken: USDC });
    const child = campaign({ apr: 5.3, parentCampaignId: parent.id }, { targetToken: VAULT });

    const index = indexMerklRewards(opportunities(parent, child), NOW);

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.053) }]);
    expect(marketSupplyRewardApys(index, MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.056) }]);
  });

  it("matches markets on the full id and reads the multilend lend side and single-token campaigns", () => {
    const index = indexMerklRewards(
      opportunities(
        campaign({ type: "MORPHOSUPPLY", apr: 1 }, { marketId: MARKET }),
        campaign({ type: "MORPHO", subType: 1, apr: 2 }, { market: MARKET.toUpperCase().replace("0X", "0x") }),
        campaign({ type: "MORPHOBORROW", apr: 50 }, { market: MARKET }),
        campaign(
          { type: "MULTILENDBORROW", apr: 3 },
          {
            markets: [
              { campaignType: 24, campaignParameters: { market: MARKET } },
              { campaignType: 45, campaignParameters: { market: OTHER_MARKET } },
            ],
          },
        ),
        campaign({ type: "MORPHOSUPPLY_SINGLETOKEN", apr: 4 }, { targetToken: USDC }),
        campaign(
          { type: "MORPHOSUPPLY", apr: 7 },
          { market: MARKET, hooks: [{ hookType: 23, protocols: ["MorphoVaultV2"] }] },
        ),
      ),
      NOW,
    );

    expect(marketSupplyRewardApys(index, MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.1) }]);
    // Only the single-token campaign reaches a market sharing the 20-byte prefix and the loan token.
    expect(marketSupplyRewardApys(index, OTHER_MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: 0.04 }]);
  });

  it("indexes the borrow side apart: direct, MORPHO subtype 2, multilend borrow and single-token", () => {
    const index = indexMerklRewards(
      opportunities(
        campaign({ type: "MORPHOBORROW", apr: 1 }, { market: MARKET }),
        campaign({ type: "MORPHO", subType: 2, apr: 2 }, { marketId: MARKET }),
        campaign(
          { type: "MULTILENDBORROW", apr: 3 },
          {
            markets: [
              { campaignType: 24, campaignParameters: { market: OTHER_MARKET } },
              { campaignType: 45, campaignParameters: { market: MARKET } },
            ],
          },
        ),
        campaign({ type: "MORPHOBORROW_SINGLETOKEN", apr: 4 }, { targetToken: USDC }),
        campaign({ type: "MORPHOSUPPLY", apr: 50 }, { market: MARKET }),
        campaign(
          { type: "MORPHOBORROW", apr: 7 },
          { market: MARKET, hooks: [{ hookType: 23, protocols: ["MorphoVaultV2"] }] },
        ),
      ),
      NOW,
    );

    expect(marketBorrowRewardApys(index, MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: expect.closeTo(0.1) }]);
    expect(marketBorrowRewardApys(index, OTHER_MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: 0.04 }]);
    // Borrow campaigns never count as supply rewards.
    expect(marketSupplyRewardApys(index, MARKET, USDC)).toEqual([{ asset: MORPHO_ASSET, apr: 0.5 }]);
  });
});

describe("getMerklRewardIndex", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchState.pages = [];
    fetchState.error = null;
    fetchState.hang = false;
    fetchState.urls.length = 0;
    fetchState.options.length = 0;
    reports.length = 0;
    restState.tokens.clear();
    restState.failing.clear();
    restState.hanging.clear();
    restState.calls.length = 0;
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  });

  it("reads the chain's live Morpho opportunities with their campaigns", async () => {
    fetchState.pages = [opportunities(campaign())];
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    const index = await getMerklRewardIndex(1);

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([{ asset: MORPHO_ASSET, apr: 0.02 }]);
    expect(fetchState.urls).toEqual([
      "https://api.merkl.xyz/v4/opportunities?mainProtocolId=morpho&chainId=1&status=LIVE&campaigns=true&items=100&page=0",
    ]);
  });

  it("pages until a short page", async () => {
    fetchState.pages = [Array.from({ length: 100 }, () => ({ campaigns: [] })), opportunities(campaign())];
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    const index = await getMerklRewardIndex(1);

    expect(fetchState.urls).toHaveLength(2);
    expect(vaultRewardApys(index, VAULT, "v2")).toHaveLength(1);
  });

  it("gives up after 3 s with no retry, even when fetch ignores its signal, and falls back to no rewards", async () => {
    vi.mocked(Date.now).mockRestore();
    fetchState.hang = true;
    fetchState.pages = [opportunities(campaign())];
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    const started = performance.now();
    const index = await getMerklRewardIndex(1);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(4_500);
    expect(index.vaults.size).toBe(0);
    expect(fetchState.options).toEqual([
      expect.objectContaining({ retryOptionOverrides: "disabled", suppressFailureEvent: true }),
    ]);
    expect(reports).toEqual([{ event: "data-fetch-error", context: { chainId: 1 } }]);
  });

  it("returns no rewards and reports one failure when Merkl is down", async () => {
    fetchState.error = new Error("Fetch failed");
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    const index = await getMerklRewardIndex(1);

    expect(vaultRewardApys(index, VAULT, "v2")).toEqual([]);
    expect(marketSupplyRewardApys(index, MARKET, USDC)).toEqual([]);
    expect(reports).toEqual([{ event: "data-fetch-error", context: { chainId: 1 } }]);
  });

  it("reads no Core REST token metadata itself", async () => {
    fetchState.pages = [
      opportunities(campaign(), campaign({ rewardToken: { ...campaign().rewardToken, address: FXN_TOKEN } })),
    ];
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    await getMerklRewardIndex(1);

    expect(restState.calls).toEqual([]);
  });

  it("returns no rewards and reports one failure on an unexpected response shape", async () => {
    fetchState.pages = [{ error: "rate limited" }];
    const { getMerklRewardIndex } = await import("@/modules/reward/data/getMerklRewardIndex");

    const index = await getMerklRewardIndex(1);

    expect(index.vaults.size).toBe(0);
    expect(reports).toHaveLength(1);
  });
});

describe("withRewardTokenMetadata", () => {
  beforeEach(() => {
    vi.resetModules();
    restState.tokens.clear();
    restState.failing.clear();
    restState.hanging.clear();
    restState.calls.length = 0;
  });

  const fxn = { ...campaign().rewardToken, address: FXN_TOKEN, symbol: "FXN", name: "FXN Token", icon: null };
  const FXN_ASSET = { ...MORPHO_ASSET, address: FXN_TOKEN, symbol: "FXN", name: "FXN Token", icon: null };

  it("shows Core's symbol, name and decimals, one quiet day-cached read per distinct shown token", async () => {
    restState.tokens.set(`/v0/tokens/1:${MORPHO_TOKEN}`, {
      data: { address: MORPHO_TOKEN, symbol: "MORPHO.core", name: "Morpho (Core)", decimals: 6 },
    });
    const index = indexMerklRewards(
      opportunities(
        campaign({ apr: 1 }),
        campaign({ apr: 2 }, { targetToken: OTHER_VAULT }),
        campaign({ type: "MORPHOSUPPLY", apr: 3 }, { market: MARKET }),
      ),
      NOW,
    );
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    const [vault, otherVault, market] = await Promise.all([
      withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2")),
      withRewardTokenMetadata(index, vaultRewardApys(index, OTHER_VAULT, "v2")),
      withRewardTokenMetadata(index, marketSupplyRewardApys(index, MARKET, USDC)),
    ]);

    const coreAsset = { ...MORPHO_ASSET, symbol: "MORPHO.core", name: "Morpho (Core)", decimals: 6 };
    expect(vault).toEqual([{ asset: coreAsset, apr: 0.01 }]);
    expect(otherVault).toEqual([{ asset: coreAsset, apr: 0.02 }]);
    expect(market).toEqual([{ asset: coreAsset, apr: 0.03 }]);
    expect(restState.calls).toEqual([
      { path: `/v0/tokens/1:${MORPHO_TOKEN}`, options: { revalidate: 86_400, quiet: true } },
    ]);
  });

  it("reads only the tokens of the rewards shown, not every token of the chain index", async () => {
    const index = indexMerklRewards(
      opportunities(campaign(), campaign({ rewardToken: fxn }, { targetToken: OTHER_VAULT })),
      NOW,
    );
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    await withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2"));

    expect(restState.calls.map(({ path }) => path)).toEqual([`/v0/tokens/1:${MORPHO_TOKEN}`]);
  });

  it("reads the reward token on its own chain and keeps Merkl's fields for what Core does not know", async () => {
    restState.tokens.set(`/v0/tokens/239:${MORPHO_TOKEN}`, {
      data: { address: MORPHO_TOKEN, symbol: null, name: "Morpho on TAC", decimals: "18" },
    });
    const index = indexMerklRewards(
      opportunities(campaign({ rewardToken: { ...campaign().rewardToken, chainId: 239 } })),
      NOW,
    );
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    const rewards = await withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2"));

    expect(rewards).toEqual([{ asset: { ...MORPHO_ASSET, name: "Morpho on TAC" }, apr: 0.02 }]);
    expect(restState.calls.map(({ path }) => path)).toEqual([`/v0/tokens/239:${MORPHO_TOKEN}`]);
  });

  it("keeps Merkl's metadata, with no read, when campaigns pay the same address on two chains", async () => {
    const index = indexMerklRewards(
      opportunities(
        campaign(),
        campaign({ rewardToken: { ...campaign().rewardToken, chainId: 8453 } }, { targetToken: OTHER_VAULT }),
      ),
      NOW,
    );
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    const rewards = await withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2"));

    expect(rewards).toEqual([{ asset: MORPHO_ASSET, apr: 0.02 }]);
    expect(restState.calls).toEqual([]);
  });

  it("keeps Merkl's metadata when Core does not know the token or fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    restState.failing.add(`/v0/tokens/1:${FXN_TOKEN}`);
    const index = indexMerklRewards(opportunities(campaign({ apr: 1 }), campaign({ rewardToken: fxn })), NOW);
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    const rewards = await withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2"));

    expect(rewards).toEqual([
      { asset: MORPHO_ASSET, apr: 0.01 },
      { asset: FXN_ASSET, apr: 0.02 },
    ]);
  });

  it("keeps Merkl's metadata after 1 s when Core never answers", async () => {
    restState.hanging.add(`/v0/tokens/1:${MORPHO_TOKEN}`);
    const index = indexMerklRewards(opportunities(campaign()), NOW);
    const { withRewardTokenMetadata } = await import("@/modules/reward/data/rewardTokenMetadata");

    const started = performance.now();
    const rewards = await withRewardTokenMetadata(index, vaultRewardApys(index, VAULT, "v2"));
    const elapsed = performance.now() - started;

    expect(rewards).toEqual([{ asset: MORPHO_ASSET, apr: 0.02 }]);
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(2_000);
  });
});
