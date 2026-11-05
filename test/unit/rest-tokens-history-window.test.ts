import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Served by path: a missing entry is a 404 (`null`), an `Error` is thrown. The real
// `MorphoRestError` and `restSelector` are kept.
const routes = new Map<string, unknown>();
const calls: { path: string; revalidate?: number }[] = [];
vi.mock("@/common/utils/fetchMorphoRest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/common/utils/fetchMorphoRest")>()),
  fetchMorphoRestResource: async (path: string, _query: unknown, options?: { revalidate?: number }) => {
    calls.push({ path, revalidate: options?.revalidate });
    const body = routes.get(path);
    if (body instanceof Error) throw body;
    return body ?? null;
  },
}));

const TOKEN = "0x0000000000000000000000000000000000000001";

describe("token decimals", () => {
  afterEach(() => routes.clear());

  it("accepts only a uint8", async () => {
    const { parseTokenDecimals } = await import("@/common/data/rest/tokens");

    expect([0, 6, 18, 255].map(parseTokenDecimals)).toEqual([0, 6, 18, 255]);
    expect([null, undefined, -1, 256, 6.5, "18", Number.NaN].map(parseTokenDecimals)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("returns null for null decimals and for an unknown token", async () => {
    const { getTokenDecimals } = await import("@/common/data/rest/tokens");

    routes.set(`/v0/tokens/1:${TOKEN}`, { data: { decimals: null } });
    await expect(getTokenDecimals(1, TOKEN)).resolves.toBeNull();

    routes.clear();
    await expect(getTokenDecimals(1, TOKEN)).resolves.toBeNull();

    routes.set(`/v0/tokens/1:${TOKEN}`, { data: { decimals: 6 } });
    await expect(getTokenDecimals(1, TOKEN)).resolves.toBe(6);
  });
});

describe("token USD price", () => {
  beforeEach(() => {
    routes.clear();
    calls.length = 0;
  });

  it("caches a price for a minute by default", async () => {
    const { getTokenPriceUsd } = await import("@/common/data/rest/tokens");
    routes.set(`/v0/tokens/1:${TOKEN}/price`, { data: { price: 2 } });

    await expect(getTokenPriceUsd(1, TOKEN)).resolves.toBe(2);
    expect(calls).toEqual([{ path: `/v0/tokens/1:${TOKEN}/price`, revalidate: 60 }]);
  });

  it("throws on a 429 by default, so Next keeps the last good page", async () => {
    const { getTokenPriceUsd } = await import("@/common/data/rest/tokens");
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(`/v0/tokens/1:${TOKEN}/price`, new MorphoRestError(429, "/price", "Too Many Requests"));

    await expect(getTokenPriceUsd(1, TOKEN)).rejects.toThrow("Morpho REST 429");
    await expect(getTokenPriceUsd(1, TOKEN, { throwWhenRateLimited: false })).resolves.toBeNull();
  });

  it("degrades any other failure, and a missing price, to null", async () => {
    const { getTokenPriceUsd } = await import("@/common/data/rest/tokens");
    const { MorphoRestError } = await import("@/common/utils/fetchMorphoRest");
    routes.set(`/v0/tokens/1:${TOKEN}/price`, new MorphoRestError(500, "/price", "Internal Server Error"));
    await expect(getTokenPriceUsd(1, TOKEN)).resolves.toBeNull();

    routes.set(`/v0/tokens/1:${TOKEN}/price`, { data: { price: null } });
    await expect(getTokenPriceUsd(1, TOKEN)).resolves.toBeNull();
  });
});

describe("vault asset decimals", () => {
  afterEach(() => routes.clear());

  it("takes the vault root's, then the token metadata's, and never guesses", async () => {
    const { getVaultAssetDecimals } = await import("@/common/data/rest/tokens");
    routes.set(`/v0/tokens/1:${TOKEN}`, { data: { decimals: 18 } });

    await expect(getVaultAssetDecimals(1, { address: TOKEN, decimals: 6 })).resolves.toBe(6);
    await expect(getVaultAssetDecimals(1, { address: TOKEN, decimals: null })).resolves.toBe(18);
    // Metadata the caller already read is used as is, even when it is missing.
    await expect(getVaultAssetDecimals(1, { address: TOKEN, decimals: null }, null)).resolves.toBeNull();

    routes.clear();
    await expect(getVaultAssetDecimals(1, { address: TOKEN, decimals: 6.5 })).resolves.toBeNull();
  });
});

describe("history lookbacks", () => {
  it("maps chart ranges as the Vaults app does", async () => {
    const { rangeLookback } = await import("@/common/data/rest/historyWindow");

    expect((["1W", "1M", "3M", "All"] as const).map(rangeLookback)).toEqual([
      "seven_days",
      "thirty_days",
      "ninety_days",
      "inception",
    ]);
  });

  it("fetches each resolution at its widest range's lookback", async () => {
    const { resolutionLookback } = await import("@/common/data/rest/historyWindow");

    expect((["hourly", "daily", "weekly"] as const).map(resolutionLookback)).toEqual([
      "seven_days",
      "ninety_days",
      "inception",
    ]);
  });
});
