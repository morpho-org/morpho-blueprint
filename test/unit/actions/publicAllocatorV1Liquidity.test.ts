import { type MarketId, MathLib } from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import type { AnvilTestClient } from "@morpho-org/test";
import { createViemTest } from "@morpho-org/test/vitest";
import { type Address, parseUnits, zeroAddress } from "viem";
import { mainnet } from "viem/chains";
import { describe, expect } from "vitest";

import { marketSupplyCollateralAndBorrowAction } from "@/actions";
import { getSimulationState } from "@/actions/data/rpc/getSimulationState";
import { computePublicAllocatorV1Liquidity } from "@/modules/market/utils/computePublicAllocatorV1Liquidity";

import { executeAction } from "../../helpers/executeAction";
import { createMarketPosition } from "../../helpers/morpho";

// A recent block: the shared fork block predates the Public Allocator V1 flow caps used here.
const test = createViemTest(mainnet, { forkUrl: process.env.MAINNET_RPC_URL_1!, forkBlockNumber: 26348400 });

const MARKET_ID = "0xef2c308b5abecf5c8750a1aa82b47c558005feb7a03f4f8e1ad682d71ac8d0ba" as MarketId; // mF-ONE/USDC
// Smokehouse USDC, a configured V1 vault with the market enabled on the Public Allocator V1.
const ALLOCATING_VAULT: Address = "0xBEeFFF209270748ddd194831b3fa287a5386f5bC";
// Steakhouse USDC, configured but without the market enabled.
const OTHER_VAULT: Address = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";
const ONE_USDC = parseUnits("1", 6);

/**
 * "Available to Borrow" is the market's liquidity plus `computePublicAllocatorV1Liquidity` over the
 * borrow action's candidates. These check it against the action itself: the bundle fills a borrow
 * just under that sum and fails its simulation just over it.
 */
describe("computePublicAllocatorV1Liquidity", () => {
  async function availableToBorrow(client: AnvilTestClient, vaults: Address[]) {
    const state = await getSimulationState({
      publicClient: client,
      accountAddress: zeroAddress,
      actionType: "market",
      marketId: MARKET_ID,
      requiresPublicReallocation: true,
      allocatingVaultAddresses: vaults,
    });
    const direct = state.getMarket(MARKET_ID).liquidity;
    return { direct, publicAllocatorV1: computePublicAllocatorV1Liquidity(state, MARKET_ID) };
  }

  async function borrow(client: AnvilTestClient, amount: bigint) {
    return marketSupplyCollateralAndBorrowAction({
      publicClient: client,
      marketId: MARKET_ID,
      allocatingVaultAddresses: [ALLOCATING_VAULT],
      accountAddress: client.account.address,
      collateralAmount: 0n,
      borrowAmount: amount,
    });
  }

  test("is 0 without a V1 candidate that has the market enabled", async ({ client }) => {
    expect((await availableToBorrow(client, [])).publicAllocatorV1).toBe(0n);
    expect((await availableToBorrow(client, [OTHER_VAULT])).publicAllocatorV1).toBe(0n);
  });

  test("a borrow just under market + V1 liquidity is filled, one just over fails simulation", async ({ client }) => {
    // Enough collateral that only liquidity binds.
    await createMarketPosition(client, MARKET_ID, parseUnits("100000000", 18), 0n);

    const { direct, publicAllocatorV1 } = await availableToBorrow(client, [ALLOCATING_VAULT]);
    expect(publicAllocatorV1).toBeGreaterThan(0n);
    const max = direct + publicAllocatorV1;

    await expect(borrow(client, max + ONE_USDC)).rejects.toThrow(/liquidity/i);

    const action = await borrow(client, MathLib.zeroFloorSub(max, ONE_USDC));
    await executeAction(client, action);
    const market = await fetchMarket(MARKET_ID, client);
    // Every reachable unit but the 1 USDC margin was borrowed.
    expect(market.liquidity).toBeLessThanOrEqual(ONE_USDC + 1n);
  });
});
