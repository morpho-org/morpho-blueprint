import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const config = vi.hoisted(() => ({ morphoApi: { requireInternal: false } }));
vi.mock("@/config", () => ({ APP_CONFIG: config }));

async function load() {
  vi.resetModules();
  return import("@/common/utils/morphoApiConfig");
}

function stubInternal(url: string, key: string) {
  vi.stubEnv("MORPHO_INTERNAL_API_URL", url);
  vi.stubEnv("MORPHO_INTERNAL_API_KEY", key);
}

describe("getMorphoApiHost", () => {
  beforeEach(() => {
    // Fallback hosts set too, so a test proves which one wins.
    vi.stubEnv("MORPHO_REST_API_URL", "");
    vi.stubEnv("MORPHO_API_URL", "https://partner.example/graphql");
    vi.stubEnv("MORPHO_API_KEY", "partner-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("internal API required (requireInternal: true)", () => {
    beforeEach(() => {
      config.morphoApi.requireInternal = true;
    });

    it("reads Core REST and the Blueprint API from the internal host", async () => {
      stubInternal("https://internal.example", "internal-key");
      const { getMorphoApiHost, isBlueprintApiEnabled } = await load();

      const internal = { baseUrl: "https://internal.example", apiKey: "internal-key" };
      expect(getMorphoApiHost("core")).toEqual(internal);
      expect(getMorphoApiHost("blueprint")).toEqual(internal);
      expect(isBlueprintApiEnabled()).toBe(true);
    });

    it("throws instead of falling back when the key or the URL is missing", async () => {
      const { getMorphoApiHost, isBlueprintApiEnabled } = await load();

      stubInternal("https://internal.example", "");
      expect(() => getMorphoApiHost("core")).toThrow("MORPHO_INTERNAL_API_KEY is unset");
      expect(() => getMorphoApiHost("blueprint")).toThrow("MORPHO_INTERNAL_API_KEY is unset");
      expect(() => isBlueprintApiEnabled()).toThrow("requireInternal");

      stubInternal("", "internal-key");
      expect(() => getMorphoApiHost("core")).toThrow("MORPHO_INTERNAL_API_URL is unset");

      stubInternal("", "");
      expect(() => getMorphoApiHost("core")).toThrow("MORPHO_INTERNAL_API_URL and MORPHO_INTERNAL_API_KEY are unset");
    });
  });

  describe("internal API optional (requireInternal: false)", () => {
    beforeEach(() => {
      config.morphoApi.requireInternal = false;
    });

    it("reads Core REST and the Blueprint API from the internal host when its key is set", async () => {
      stubInternal("https://internal.example", "internal-key");
      const { getMorphoApiHost, isBlueprintApiEnabled } = await load();

      const internal = { baseUrl: "https://internal.example", apiKey: "internal-key" };
      expect(getMorphoApiHost("core")).toEqual(internal);
      expect(getMorphoApiHost("blueprint")).toEqual(internal);
      expect(isBlueprintApiEnabled()).toBe(true);
    });

    it("falls back without the internal key: Core REST on the fallback hosts, Blueprint API off", async () => {
      stubInternal("https://internal.example", "");
      const { getMorphoApiHost, isBlueprintApiEnabled } = await load();

      expect(getMorphoApiHost("blueprint")).toBeNull();
      expect(isBlueprintApiEnabled()).toBe(false);
      // The former GraphQL endpoint's host.
      expect(getMorphoApiHost("core")).toEqual({ baseUrl: "https://partner.example", apiKey: "partner-key" });

      vi.stubEnv("MORPHO_API_URL", "https://partner.example/graphql/");
      expect(getMorphoApiHost("core").baseUrl).toBe("https://partner.example");

      vi.stubEnv("MORPHO_REST_API_URL", "https://rest.example");
      expect(getMorphoApiHost("core").baseUrl).toBe("https://rest.example");

      vi.stubEnv("MORPHO_REST_API_URL", "");
      vi.stubEnv("MORPHO_API_URL", "");
      vi.stubEnv("MORPHO_API_KEY", "");
      expect(getMorphoApiHost("core")).toEqual({ baseUrl: "https://api.morpho.org", apiKey: undefined });
    });

    it("refuses an internal key without the internal host", async () => {
      stubInternal("", "internal-key");
      const { getMorphoApiHost } = await load();

      expect(() => getMorphoApiHost("blueprint")).toThrow("without MORPHO_INTERNAL_API_URL");
      expect(() => getMorphoApiHost("core")).toThrow("without MORPHO_INTERNAL_API_URL");
    });
  });
});
