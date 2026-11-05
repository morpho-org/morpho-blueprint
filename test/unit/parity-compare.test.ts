import { describe, expect, it } from "vitest";
import { classify, diffDumps, globToRegExp, toleranceFor } from "../../scripts/verify/parity-compare-lib.mjs";

const vault = (overrides: Record<string, unknown> = {}) => ({
  vaultAddress: "0xA",
  totalAssets: { raw: "1000000000", formatted: "1000", usd: 1000 },
  apy: { total: 0.05 },
  allocations: [{ adapterAddress: "0x1", relativeCap: { raw: "1000000000000000000", formatted: "1" } }],
  sentinelAddresses: ["0xS1", "0xS2"],
  ...overrides,
});

describe("parity compare", () => {
  it("classifies leaves by path", () => {
    expect(toleranceFor("data.vaults.x.totalAssets.usd").kind).toBe("usd");
    expect(toleranceFor("data.vaults.x.curatorAum").kind).toBe("usd");
    expect(toleranceFor("data.vaults.x.totalAssets.formatted").kind).toBe("amount");
    expect(toleranceFor("data.x.market.lltv.formatted").kind).toBe("ratio");
    expect(toleranceFor("data.x.market.lltv.raw").kind).toBe("amount");
    expect(toleranceFor("data.x.apy.total").kind).toBe("exact");
  });

  it("finds nothing between identical dumps", () => {
    expect(diffDumps({ v: [vault()] }, { v: [vault()] }).differences).toEqual([]);
  });

  it("applies the amount, ratio and USD tolerances", () => {
    const within = vault({ totalAssets: { raw: "1000005000", formatted: "1000.005", usd: 1000.9 } });
    expect(diffDumps({ v: [vault()] }, { v: [within] }).differences).toEqual([]);

    const beyond = vault({ totalAssets: { raw: "1000020000", formatted: "1000", usd: 1002 } });
    const paths = diffDumps({ v: [vault()] }, { v: [beyond] }).differences.map((d) => d.path);
    expect(paths).toEqual(["data.v[0xA].totalAssets.raw", "data.v[0xA].totalAssets.usd"]);
  });

  it("compares any other number exactly", () => {
    const { differences } = diffDumps({ v: [vault()] }, { v: [vault({ apy: { total: 0.0500001 } })] });
    expect(differences).toEqual([{ kind: "value", path: "data.v[0xA].apy.total", base: "0.05", head: "0.0500001" }]);
  });

  it("matches entities by identity and address lists as sets", () => {
    const a = { v: [vault(), vault({ vaultAddress: "0xB" })] };
    const b = { v: [vault({ vaultAddress: "0xB", sentinelAddresses: ["0xS2", "0xS1"] }), vault()] };
    expect(diffDumps(a, b).differences).toEqual([]);

    const dropped = { v: [vault({ sentinelAddresses: ["0xS1"] })] };
    expect(diffDumps({ v: [vault()] }, dropped).differences).toEqual([
      { kind: "missing", path: "data.v[0xA].sentinelAddresses[0xS2]", base: '"0xS2"', head: "(absent)" },
    ]);
  });

  it("compares chart series on their common window only", () => {
    const point = (t: number, y = 0.05) => ({ bucketTimestamp: t, netApy: { total: y } });
    const a = { s: [point(1), point(2), point(3)] };
    const b = { s: [point(2), point(3), point(4)] };
    expect(diffDumps(a, b)).toEqual({ differences: [], trimmedPoints: 2 });

    const gap = { s: [point(2), point(4)] };
    expect(diffDumps(a, gap).differences.map((d) => d.path)).toEqual(["data.s[3]"]);
  });

  it("reports chart coverage lost beyond one edge bucket, or no overlap at all", () => {
    const point = (t: number) => ({ bucketTimestamp: t, netApy: { total: 0.05 } });
    const shrunk = diffDumps({ s: [point(1), point(2), point(3)] }, { s: [point(2)] }).differences;
    expect(shrunk).toEqual([]);

    const lost = diffDumps({ s: [1, 2, 3, 4, 5].map(point) }, { s: [point(4), point(5)] }).differences;
    expect(lost.map((d) => [d.kind, d.path])).toEqual([["missing", "data.s(window)"]]);

    const disjoint = diffDumps({ s: [point(1), point(2)] }, { s: [point(3), point(4)] }).differences;
    expect(disjoint.map((d) => [d.kind, d.path])).toEqual([["value", "data.s(window)"]]);
  });

  it("accepts only differences an entry covers, within its bound", () => {
    const differences: { kind: "value" | "missing" | "extra"; path: string; base: string; head: string }[] = [
      {
        kind: "value",
        path: "data.vaults.1:0xA.allocations[0x1].market.supplyApy6h.total",
        base: "0.05",
        head: "0.0501",
      },
      {
        kind: "value",
        path: "data.vaults.1:0xA.allocations[0x1].market.supplyApy1d.total",
        base: "0.05",
        head: "0.07",
      },
      { kind: "missing", path: "data.vaults.1:0xA.name", base: '"x"', head: "(absent)" },
    ];
    const { accepted, unexpected, unused } = classify(differences, [
      { path: "data.vaults.**.market.supplyApy*.*", kind: "value", relative: 0.01, reason: "live", ticket: "T-1" },
      { path: "data.vaults.*.curatorAum", reason: "hidden", ticket: "T-2" },
    ]);
    expect(accepted.map((d) => d.path)).toEqual([differences[0]?.path]);
    expect(unexpected.map((d) => d.path)).toEqual([differences[1]?.path, differences[2]?.path]);
    expect(unused.map((entry) => entry.ticket)).toEqual(["T-2"]);
  });

  it("keeps * inside one path segment", () => {
    expect(globToRegExp("data.vaults.*.name").test("data.vaults.1:0xA.name")).toBe(true);
    expect(globToRegExp("data.*.name").test("data.vaults.1:0xA.name")).toBe(false);
    expect(globToRegExp("data.**.name").test("data.vaults.1:0xA.name")).toBe(true);
  });
});
