import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

async function load() {
  vi.resetModules();
  return import("@/common/utils/morphoApiConfig");
}

describe("getMorphoApiHost", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("puts Core REST on the GraphQL API's host and key", async () => {
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_URL", "https://partner.example/graphql/");
    vi.stubEnv("MORPHO_API_KEY", "core-key");
    const { getMorphoApiHost } = await load();

    expect(getMorphoApiHost("core")).toEqual({ baseUrl: "https://partner.example", apiKey: "core-key" });
  });

  it("lets MORPHO_REST_API_URL override the Core host, and defaults to the public keyless API", async () => {
    vi.stubEnv("MORPHO_API_URL", "https://partner.example/graphql");
    vi.stubEnv("MORPHO_REST_API_URL", "https://rest.example");
    const { getMorphoApiHost } = await load();
    expect(getMorphoApiHost("core").baseUrl).toBe("https://rest.example");

    vi.stubEnv("MORPHO_API_URL", "");
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_KEY", "");
    expect(getMorphoApiHost("core")).toEqual({ baseUrl: "https://api.morpho.org", apiKey: undefined });
  });

  it("switches the Blueprint API on only when MORPHO_INTERNAL_API_KEY is set", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_URL", "https://internal.example");
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "");
    const { getMorphoApiHost, isBlueprintApiEnabled } = await load();
    expect(getMorphoApiHost("blueprint")).toBeNull();
    expect(isBlueprintApiEnabled()).toBe(false);

    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    expect(getMorphoApiHost("blueprint")).toEqual({ baseUrl: "https://internal.example", apiKey: "internal-key" });
    expect(isBlueprintApiEnabled()).toBe(true);
  });

  it("refuses an internal key without the internal host", async () => {
    vi.stubEnv("MORPHO_INTERNAL_API_URL", "");
    vi.stubEnv("MORPHO_INTERNAL_API_KEY", "internal-key");
    const { getMorphoApiHost } = await load();

    expect(() => getMorphoApiHost("blueprint")).toThrow("without MORPHO_INTERNAL_API_URL");
  });
});
