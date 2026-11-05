import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const blueprint = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/common/utils/morphoApiConfig", () => ({ isBlueprintApiEnabled: () => blueprint.enabled }));

// The AUM route is not paged: it takes at most 100 curator ids and answers every known one at once
// (morpho-org/backend#7397). The real `chunk` runs; only the request is faked.
const requests = vi.hoisted((): string[][] => []);
vi.mock("@/common/utils/fetchMorphoRest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/common/utils/fetchMorphoRest")>()),
  fetchMorphoRest: async (_path: string, query: { curators: string[] }) => {
    requests.push(query.curators);
    return { data: query.curators.map((id) => ({ curator_id: id, aum_usd: Number(id.slice(1)) })) };
  },
}));

const { getCuratorsAumUsd } = await import("@/common/data/rest/curators");
const ids = (count: number) => Array.from({ length: count }, (_, i) => `c${i}`);

describe("getCuratorsAumUsd", () => {
  beforeEach(() => {
    requests.length = 0;
    blueprint.enabled = true;
  });

  it("sends 100 ids per request and merges every batch", async () => {
    const aums = await getCuratorsAumUsd(ids(250));

    expect(requests.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(requests.flat()).toEqual(ids(250));
    expect(aums.size).toBe(250);
    expect(aums.get("c249")).toBe(249);
  });

  it("dedupes ids before batching", async () => {
    await getCuratorsAumUsd([...ids(100), ...ids(100)]);

    expect(requests).toEqual([ids(100)]);
  });

  it("reads nothing without ids or with the Blueprint API off", async () => {
    expect((await getCuratorsAumUsd([])).size).toBe(0);
    blueprint.enabled = false;
    expect((await getCuratorsAumUsd(ids(3))).size).toBe(0);
    expect(requests).toEqual([]);
  });
});
