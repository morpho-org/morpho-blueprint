import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const routes = new Map<string, unknown>();
vi.mock("@/common/utils/fetchMorphoRest", () => ({
  fetchMorphoRestResource: async (path: string) => routes.get(path) ?? null,
  restSelector: (chainId: number, id: string) => `${chainId}:${id}`,
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
