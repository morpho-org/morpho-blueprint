import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const trackEvent = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/common/utils/trackEvent", () => ({ trackEvent }));

const fetchMock = vi.fn();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function load() {
  return import("@/common/utils/fetchMorphoRest");
}

describe("fetchMorphoRest", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    trackEvent.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds the URL from the selector and query, and sends the API key", async () => {
    vi.stubEnv("MORPHO_API_URL", "");
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_KEY", "test-key");
    fetchMock.mockResolvedValueOnce(json(200, { data: { ok: true } }));
    const { fetchMorphoRest, restSelector } = await load();

    await expect(
      fetchMorphoRest(`/v0/vaults-v2/${restSelector(1, "0xabc")}`, { chain_ids: [1, 8453], active_only: true }),
    ).resolves.toEqual({ data: { ok: true } });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.morpho.org/v0/vaults-v2/1:0xabc?chain_ids=1%2C8453&active_only=true");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
  });

  it("returns null for a missing single resource, without reporting it", async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { statusCode: 404, message: "cannot find vault v1 config", error: "Not Found" }),
    );
    const { fetchMorphoRestResource } = await load();

    await expect(fetchMorphoRestResource("/v0/vaults-v1/1:0xabc")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("throws on a 404 for an unknown route, even on a resource read", async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { statusCode: 404, message: "Cannot GET /v0/vaults-v9/1:0xabc", error: "Not Found" }),
    );
    const { fetchMorphoRestResource, MorphoRestError } = await load();

    const error = await fetchMorphoRestResource("/v0/vaults-v9/1:0xabc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MorphoRestError);
    expect(error).toMatchObject({ status: 404 });
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("throws on any 404 outside a resource read", async () => {
    fetchMock.mockResolvedValueOnce(
      json(404, { statusCode: 404, message: "cannot find vault v1 config", error: "Not Found" }),
    );
    const { fetchMorphoRest } = await load();

    await expect(fetchMorphoRest("/v0/vaults-v1/1:0xabc")).rejects.toMatchObject({ status: 404 });
  });

  it("logs a failure the caller falls back from as a warning, with no error event", async () => {
    fetchMock.mockImplementation(async () => json(500, { statusCode: 500, message: "boom" }));
    const { fetchMorphoRestResource } = await load();

    await expect(fetchMorphoRestResource("/v0/tokens/1:0xabc/price", undefined, { quiet: true })).rejects.toThrow(
      "boom",
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("using the fallback"));
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("reads Core REST on the GraphQL API's host, and Blueprint API routes on the internal host", async () => {
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_URL", "https://partner.example/graphql");
    vi.stubEnv("MORPHO_API_KEY", "core-key");
    vi.stubEnv("MORPHO_INTERNAL_API_URL", "https://internal.example");
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    fetchMock.mockImplementation(async () => json(200, { data: 1 }));
    const { fetchMorphoRest } = await load();

    await fetchMorphoRest("/v0/tokens/1:0xabc");
    await fetchMorphoRest("/v0/blueprint-app-api/curators", undefined, { api: "blueprint" });

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      key: new Headers(init?.headers).get("x-api-key"),
    }));
    expect(calls).toEqual([
      { url: "https://partner.example/v0/tokens/1:0xabc", key: "core-key" },
      { url: "https://internal.example/v0/blueprint-app-api/curators", key: "internal-key" },
    ]);
  });

  it("refuses a Blueprint API read while its key is unset", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_URL", "https://internal.example");
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "");
    const { fetchMorphoRest } = await load();

    await expect(fetchMorphoRest("/v0/blueprint-app-api/curators", undefined, { api: "blueprint" })).rejects.toThrow(
      "Blueprint API is off",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws the error envelope's message on a client error, without retrying", async () => {
    fetchMock.mockResolvedValue(
      json(400, { statusCode: 400, message: ["limit must be at most 100", "bad cursor"], error: "Bad Request" }),
    );
    const { fetchMorphoRest, MorphoRestError } = await load();

    const error = await fetchMorphoRest("/v0/blue/users/0xabc/positions").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MorphoRestError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toContain("limit must be at most 100; bad cursor");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a server error once", async () => {
    fetchMock
      .mockResolvedValueOnce(json(503, { statusCode: 503, message: "unavailable", error: "Service Unavailable" }))
      .mockResolvedValueOnce(json(200, { data: 1 }));
    const { fetchMorphoRest } = await load();

    await expect(fetchMorphoRest("/v0/tokens/1:0xabc/price")).resolves.toEqual({ data: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws once retries are exhausted", async () => {
    fetchMock.mockImplementation(async () =>
      json(500, { statusCode: 500, message: "boom", error: "Internal Server Error" }),
    );
    const { fetchMorphoRest } = await load();

    await expect(fetchMorphoRest("/v0/tokens/1:0xabc/price")).rejects.toThrow("boom");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses an empty array filter, which the API would read as no filter", async () => {
    const { fetchMorphoRest } = await load();

    await expect(fetchMorphoRest("/v0/blue/users/0xabc/positions", { market_ids: [] })).rejects.toThrow(
      'Empty "market_ids" filter',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps at most 16 calls in flight across every read, and runs the rest as slots free up", async () => {
    let inFlight = 0;
    let peak = 0;
    const pending: (() => void)[] = [];
    fetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      return json(200, { data: 1 });
    });
    const { fetchMorphoRest, fetchMorphoRestResource } = await load();

    const reads = Array.from({ length: 20 }, (_, i) =>
      i % 2 ? fetchMorphoRest(`/v0/tokens/1:0x${i}`) : fetchMorphoRestResource(`/v0/tokens/1:0x${i}`),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(16));
    expect(fetchMock).toHaveBeenCalledTimes(16);

    // Each finished call lets one queued call start, until every read is served.
    while (fetchMock.mock.calls.length < 20 || pending.length > 0) {
      pending.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await expect(Promise.all(reads)).resolves.toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(peak).toBe(16);
  });

  it("only passes a cache lifetime when one is asked for", async () => {
    fetchMock.mockImplementation(async () => json(200, { data: 1 }));
    const { fetchMorphoRest } = await load();

    await fetchMorphoRest("/v0/tokens/1:0xabc");
    await fetchMorphoRest("/v0/tokens/1:0xabc", undefined, { revalidate: 60 });

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("next");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ next: { revalidate: 60 } });
  });
});

describe("fetchAllMorphoRestPages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows the cursor through partial pages until it is null", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { data: [1, 2], cursor: "c1" }))
      .mockResolvedValueOnce(json(200, { data: [3], cursor: "c2" }))
      .mockResolvedValueOnce(json(200, { data: [], cursor: null }));
    const { fetchAllMorphoRestPages } = await load();

    await expect(fetchAllMorphoRestPages("/v0/blue/users/0xabc/positions", { chain_ids: [1] })).resolves.toEqual([
      1, 2, 3,
    ]);

    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "c1", "c2"]);
    expect(urls.every((url) => url.searchParams.get("limit") === "100")).toBe(true);
    expect(urls.every((url) => url.searchParams.get("chain_ids") === "1")).toBe(true);
  });

  it("throws on a 404 instead of reading it as an empty list", async () => {
    fetchMock.mockResolvedValueOnce(json(404, { statusCode: 404, message: "no user", error: "Not Found" }));
    const { fetchAllMorphoRestPages } = await load();

    await expect(fetchAllMorphoRestPages("/v0/blue/users/0xabc/positions")).rejects.toMatchObject({ status: 404 });
  });

  it("throws instead of truncating a list that never ends", async () => {
    fetchMock.mockImplementation(async () => json(200, { data: [1], cursor: "again" }));
    const { fetchAllMorphoRestPages } = await load();

    await expect(fetchAllMorphoRestPages("/v0/blue/users/0xabc/positions")).rejects.toThrow("did not end within 50");
    expect(fetchMock).toHaveBeenCalledTimes(50);
  });

  it("fails the whole list when a later page errors", async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { data: [1], cursor: "c1" }))
      .mockResolvedValueOnce(json(400, { statusCode: 400, message: "INVALID_CURSOR: stale", error: "Bad Request" }));
    const { fetchAllMorphoRestPages } = await load();

    await expect(fetchAllMorphoRestPages("/v0/blue/users/0xabc/positions")).rejects.toThrow("INVALID_CURSOR");
  });
});

describe("chunk", () => {
  it("splits filters at the API's 100-item cap", async () => {
    const { chunk } = await load();
    const chunks = chunk(Array.from({ length: 250 }, (_, i) => i));
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
  });
});
