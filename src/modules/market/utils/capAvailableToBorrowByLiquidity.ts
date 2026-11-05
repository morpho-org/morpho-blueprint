import { MathLib } from "@morpho-org/blue-sdk";
import type { MarketPositionChange } from "@/actions";

/**
 * Caps the position's "available to borrow" (collateral headroom) by what the market can still lend:
 * `marketAvailableToBorrow` (direct liquidity plus Public Allocator V2) before the borrow, and that amount minus
 * the borrow being entered (floored at 0) after it.
 */
export function capAvailableToBorrowByLiquidity({
  positionChange,
  marketAvailableToBorrow,
  borrowAmount,
}: {
  positionChange: MarketPositionChange;
  marketAvailableToBorrow: bigint;
  borrowAmount: bigint;
}): MarketPositionChange {
  const liquidityBefore = MathLib.max(marketAvailableToBorrow, 0n);
  const liquidityAfter = MathLib.zeroFloorSub(liquidityBefore, MathLib.max(borrowAmount, 0n));

  return {
    ...positionChange,
    availableToBorrow: {
      before: MathLib.min(positionChange.availableToBorrow.before, liquidityBefore),
      after: MathLib.min(positionChange.availableToBorrow.after, liquidityAfter),
    },
  };
}
