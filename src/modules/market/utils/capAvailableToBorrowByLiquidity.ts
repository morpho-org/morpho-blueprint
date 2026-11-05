import { MathLib } from "@morpho-org/blue-sdk";
import type { MarketPositionChange } from "@/actions";

/**
 * Caps the position's "available to borrow" (collateral headroom) by what the market can still lend.
 *
 * Before the action, the cap is `marketAvailableToBorrow` (direct liquidity plus Public Allocator V2). After it, the
 * position's loan change moves that liquidity: a borrow takes the borrowed amount out, a repay puts the repaid amount
 * back, and a collateral-only change leaves it as is. The result is floored at 0.
 */
export function capAvailableToBorrowByLiquidity({
  positionChange,
  marketAvailableToBorrow,
}: {
  positionChange: MarketPositionChange;
  marketAvailableToBorrow: bigint;
}): MarketPositionChange {
  const liquidityBefore = MathLib.max(marketAvailableToBorrow, 0n);
  const loanChange = positionChange.loan.after - positionChange.loan.before;
  const liquidityAfter = MathLib.max(liquidityBefore - loanChange, 0n);

  return {
    ...positionChange,
    availableToBorrow: {
      before: MathLib.min(positionChange.availableToBorrow.before, liquidityBefore),
      after: MathLib.min(positionChange.availableToBorrow.after, liquidityAfter),
    },
  };
}
