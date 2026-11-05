import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config", () => ({ APP_CONFIG: { supportedVaults: {}, featureFlags: {}, apyWindow: "6h" } }));

const { getColumns, hasCuratorAum } = await import("@/modules/vault/components/VaultTable");
type Summary = Parameters<typeof hasCuratorAum>[0][number];

const summary = (curatorAum?: number) => ({ curatorAum }) as Summary;
const curatorColumn = (showCuratorAum: boolean) => getColumns(false, showCuratorAum).find(({ id }) => id === "curator");

describe("earn table curator column", () => {
  it("shows AUM only when at least one row has it", () => {
    expect(hasCuratorAum([summary(), summary()])).toBe(false);
    expect(hasCuratorAum([summary(), summary(1_000)])).toBe(true);
  });

  it("is the curator alone, not sortable, without AUM", () => {
    expect(curatorColumn(false)).toMatchObject({ header: "Curator", enableSorting: false });
  });

  it("is labelled and sortable by AUM with it, rows without AUM last", () => {
    expect(curatorColumn(true)).toMatchObject({ header: "Curator AUC", enableSorting: true, sortUndefined: "last" });
  });
});
