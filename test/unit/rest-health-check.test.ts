// @vitest-environment node

import { afterEach, describe, expect, test, vi } from "vitest";
import { dynamic, GET } from "@/app/api/health-check/rest/route";

const market = { chain_id: 1, market_id: `0x${"a".repeat(64)}` };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("REST runtime health check", () => {
  test("makes a fresh keyless request and returns runtime evidence without upstream data", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(Response.json({ data: [market] }, { headers: { "x-request-id": "upstream-request" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "test-commit");
    vi.stubEnv("MORPHO_API_URL", "https://dedicated.example/graphql");
    vi.stubEnv("MORPHO_API_KEY", "test-key");

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      ok: true,
      checkedAt: expect.any(String),
      environment: "preview",
      commit: "test-commit",
      upstreamStatus: 200,
      requestId: "upstream-request",
    });
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("https://api.morpho.org/v1/blue/markets?chain_id=1&limit=1", {
      cache: "no-store",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(dynamic).toBe("force-dynamic");
    await GET();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("reports upstream rate limiting as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, upstreamStatus: 429 });
  });

  test.each([
    {},
    { data: [] },
    { data: [{ ...market, chain_id: 8453 }] },
    { data: [{ ...market, market_id: "not-a-market" }] },
    { data: [null] },
  ])("rejects an invalid success payload: %j", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, upstreamStatus: 200 });
  });

  test("rejects non-JSON success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>not JSON</html>")));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, upstreamStatus: 200 });
  });

  test.each([new Error("private transport detail"), new DOMException("timed out", "TimeoutError")])(
    "reports transport failures without disclosing exception messages",
    async (error) => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
      const response = await GET();
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ ok: false, upstreamStatus: null, requestId: null });
      expect(JSON.stringify(body)).not.toContain(error.message);
    },
  );
});
