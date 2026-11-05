import type { BlueActions } from "@morpho-org/morpho-sdk";
import { createMockClient } from "@morpho-org/test/mock";
import type { Address } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect, test, vi } from "vitest";
import { getMarketBorrowReallocations } from "@/actions/utils/getMarketBorrowReallocations";

function setup() {
  const handle = createMockClient(mainnet);
  handle.request.mockImplementation(async ({ method }) => {
    if (method === "eth_getBlockByNumber") {
      return { number: "0x123", timestamp: "0x456", transactions: [] };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  const data = {} as Awaited<ReturnType<BlueActions["getVaultV2BlueReallocationData"]>>;
  const reallocations = [] as ReturnType<BlueActions["getVaultV2BlueReallocations"]>["reallocations"];
  const market = {
    getVaultV2BlueReallocationData: vi.fn(async () => data),
    getVaultV2BlueReallocations: vi.fn(() => ({ reallocations, data })),
  };
  // The market page's candidates: the vaults V2 Core lists for the Public Allocator V2.
  const addresses: Address[] = ["0x0000000000000000000000000000000000000002"];
  return { handle, market, data, reallocations, addresses };
}

describe("getMarketBorrowReallocations", () => {
  test("passes the candidate vaults and the current block into a borrow reallocation plan", async () => {
    const { handle, market, data, reallocations, addresses } = setup();
    const result = await getMarketBorrowReallocations({
      publicClient: handle.client,
      market,
      marketData: { totalSupplyAssets: 100n, totalBorrowAssets: 90n },
      borrowAmount: 20n,
      allocatingVaultAddresses: addresses,
    });
    expect(market.getVaultV2BlueReallocationData).toHaveBeenCalledWith({
      vaultAddresses: ["0x0000000000000000000000000000000000000002"],
      block: expect.objectContaining({ number: 0x123n, timestamp: 0x456n }),
    });
    expect(market.getVaultV2BlueReallocations).toHaveBeenCalledWith({
      reallocationData: data,
      options: { operation: { type: "borrow", amount: 20n } },
    });
    expect(result).toBe(reallocations);
  });

  test.each([
    { borrowAmount: 0n, totalBorrowAssets: 100n, empty: false },
    { borrowAmount: 1n, totalBorrowAssets: 0n, empty: false },
    { borrowAmount: 20n, totalBorrowAssets: 90n, empty: true },
  ])("skips unnecessary or unavailable reallocations: %s", async ({ borrowAmount, totalBorrowAssets, empty }) => {
    const { handle, market, addresses } = setup();
    expect(
      await getMarketBorrowReallocations({
        publicClient: handle.client,
        market,
        marketData: { totalSupplyAssets: 100n, totalBorrowAssets },
        borrowAmount,
        allocatingVaultAddresses: empty ? [] : addresses,
      }),
    ).toBeUndefined();
    expect(market.getVaultV2BlueReallocationData).not.toHaveBeenCalled();
    expect(handle.request).not.toHaveBeenCalled();
  });

  test("propagates reallocation-data errors rather than borrowing without a plan", async () => {
    const { handle, market, addresses } = setup();
    const error = new Error("Reallocation unavailable");
    market.getVaultV2BlueReallocationData.mockRejectedValueOnce(error);
    await expect(
      getMarketBorrowReallocations({
        publicClient: handle.client,
        market,
        marketData: { totalSupplyAssets: 100n, totalBorrowAssets: 90n },
        borrowAmount: 20n,
        allocatingVaultAddresses: addresses,
      }),
    ).rejects.toBe(error);
    expect(market.getVaultV2BlueReallocations).not.toHaveBeenCalled();
  });
});
