import { type MarketId, MathLib } from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import type { AnvilTestClient } from "@morpho-org/test";
import { createViemTest } from "@morpho-org/test/vitest";
import { type Address, erc20Abi, parseUnits } from "viem";
import { readContract } from "viem/actions";
import { mainnet } from "viem/chains";
import { describe, expect } from "vitest";

import { marketSupplyCollateralAndBorrowAction } from "@/actions";

import { executeAction } from "../../helpers/executeAction";
import { createMarketPosition } from "../../helpers/morpho";

/**
 * "Available to Borrow" is Core's `market_liquidity` + `reallocatable_liquidity`, with the vaults
 * from `/public-allocator-vaults` as the borrow's candidates. The fork sits on the block Core had
 * indexed when these figures were read (2026-11-05), so Core and the chain describe the same state.
 */
const BLOCK = 26348902n;
const test = createViemTest(mainnet, { forkUrl: process.env.MAINNET_RPC_URL_1!, forkBlockNumber: BLOCK });

const ONE_USDC = parseUnits("1", 6);

const CASES = {
  // A market whose extra liquidity sits behind a vault V2 Public Allocator.
  v2: {
    marketId: "0xb25c41cd266fa6cb9c581d526ac9d8c0137c92cd06847f7e1ee511764ee3d42f" as MarketId,
    candidates: ["0x069662D2588fcaC24B5c209456Db965D151556f0"] as Address[],
    marketLiquidity: 36_746_958265n,
    reallocatableLiquidity: 1_580_549_417593n,
  },
  // mF-ONE/USDC: Core lists a vault V2 candidate but reports nothing to reallocate.
  mfOne: {
    marketId: "0xef2c308b5abecf5c8750a1aa82b47c558005feb7a03f4f8e1ad682d71ac8d0ba" as MarketId,
    candidates: ["0xbeeff2C5bF38f90e3482a8b19F12E5a6D2FCa757"] as Address[],
    marketLiquidity: 2_923_152_592672n,
    reallocatableLiquidity: 0n,
  },
};

async function borrow(client: AnvilTestClient, c: (typeof CASES)[keyof typeof CASES], amount: bigint) {
  return marketSupplyCollateralAndBorrowAction({
    publicClient: client,
    marketId: c.marketId,
    allocatingVaultAddresses: c.candidates,
    accountAddress: client.account.address,
    collateralAmount: 0n,
    borrowAmount: amount,
  });
}

/** Enough collateral that only liquidity binds. */
async function fundCollateral(client: AnvilTestClient, marketId: MarketId, borrowAmount: bigint) {
  const market = await fetchMarket(marketId, client);
  const collateral = MathLib.mulDivUp(borrowAmount * 4n, 10n ** 36n, market.price!);
  await createMarketPosition(client, marketId, collateral, 0n);
  return market;
}

describe("Available to Borrow through the Public Allocator V2", () => {
  test("Core's market liquidity matches the fork", async ({ client }) => {
    for (const c of Object.values(CASES)) {
      const market = await fetchMarket(c.marketId, client);
      // Interest accrues between Core's index and the fork read: allow 0.01%.
      const diff =
        market.liquidity > c.marketLiquidity
          ? market.liquidity - c.marketLiquidity
          : c.marketLiquidity - market.liquidity;
      expect(diff * 10_000n).toBeLessThanOrEqual(c.marketLiquidity);
    }
  });

  test("a borrow at direct + V2 reallocatable liquidity executes through morpho-sdk", async ({ client }) => {
    const c = CASES.v2;
    const cap = c.marketLiquidity + c.reallocatableLiquidity;
    const before = await fundCollateral(client, c.marketId, cap);
    expect(cap).toBeGreaterThan(before.liquidity);

    const action = await borrow(client, c, cap);
    await executeAction(client, action);

    const after = await fetchMarket(c.marketId, client);
    expect(after.totalBorrowAssets - before.totalBorrowAssets).toBeGreaterThanOrEqual(cap);
    const usdc = await readContract(client, {
      address: before.params.loanToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [client.account.address],
    });
    expect(usdc).toBe(cap);
  });

  test("1 USDC above it fails before signing: the SDK reaches exactly Core's figure", async ({ client }) => {
    const c = CASES.v2;
    const cap = c.marketLiquidity + c.reallocatableLiquidity;
    await fundCollateral(client, c.marketId, cap * 2n);
    await expect(borrow(client, c, cap + ONE_USDC)).rejects.toThrow(
      new RegExp(`Shared liquidity is insufficient.*available "${c.reallocatableLiquidity}"`),
    );
  });

  test("mF-ONE/USDC: Available to Borrow is direct liquidity, and a borrow at it executes", async ({ client }) => {
    const c = CASES.mfOne;
    const cap = c.marketLiquidity + c.reallocatableLiquidity;
    expect(cap).toBe(c.marketLiquidity);
    const before = await fundCollateral(client, c.marketId, cap);
    // Core's index can trail the fork by a few blocks of interest: borrow what the fork holds, within 1 USDC of Core.
    const amount = MathLib.min(cap, before.liquidity);
    expect(cap - amount).toBeLessThanOrEqual(ONE_USDC);

    await executeAction(client, await borrow(client, c, amount));
    const after = await fetchMarket(c.marketId, client);
    expect(after.liquidity).toBeLessThanOrEqual(ONE_USDC);
  });
});
