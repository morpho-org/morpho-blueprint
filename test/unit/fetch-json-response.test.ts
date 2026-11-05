import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJsonResponse } from "@/common/utils/fetch";
import { trackEvent } from "@/common/utils/trackEvent";

vi.mock("@/common/utils/trackEvent", () => ({ trackEvent: vi.fn() }));

describe("fetchJsonResponse failure logging", () => {
  beforeEach(() => {
    vi.mocked(trackEvent).mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503, statusText: "Service Unavailable" }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warns, with no event, when the caller owns the fallback", async () => {
    await expect(
      fetchJsonResponse("https://api.merkl.xyz/v4/opportunities", {
        retryOptionOverrides: "disabled",
        suppressFailureEvent: true,
      }),
    ).rejects.toThrow("Fetch failed");

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Fetch failed for https://api.merkl.xyz"));
    expect(console.error).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("logs an error and raises data-fetch-error otherwise", async () => {
    await expect(
      fetchJsonResponse("https://api.merkl.xyz/v4/opportunities", { retryOptionOverrides: "disabled" }),
    ).rejects.toThrow("Fetch failed");

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Fetch failed for https://api.merkl.xyz"));
    expect(trackEvent).toHaveBeenCalledWith(
      "data-fetch-error",
      expect.objectContaining({ url: "https://api.merkl.xyz/v4/opportunities" }),
    );
  });
});
