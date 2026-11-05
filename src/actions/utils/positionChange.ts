import { type Market, MathLib, type Position } from "@morpho-org/blue-sdk";
import { APP_CONFIG } from "@/config";
import type { MarketPositionChange } from "../types";

export function computeMarketPositionChange(
  market: Market,
  position: Position,
  collateralDelta: bigint,
  loanDelta: bigint,
): MarketPositionChange {
  const collateralBefore = position.collateral;
  const collateralAfter = MathLib.max(0n, collateralBefore + collateralDelta);
  const loanBefore = market.toBorrowAssets(position.borrowShares);
  const loanAfter = MathLib.max(0n, loanBefore + loanDelta);
  const maxLtv = MathLib.zeroFloorSub(market.params.lltv, APP_CONFIG.actionParameters.maxBorrowLtvMarginWad);
  return {
    collateral: { before: collateralBefore, after: collateralAfter },
    loan: { before: loanBefore, after: loanAfter },
    ltv: {
      before: market.getLtv(position) ?? 0n,
      after: market.getLtv({ collateral: collateralAfter, borrowShares: market.toBorrowShares(loanAfter) }) ?? 0n,
    },
    availableToBorrow: {
      before: MathLib.zeroFloorSub(market.getMaxBorrowAssets(collateralBefore, { maxLtv }) ?? 0n, loanBefore),
      after: MathLib.zeroFloorSub(market.getMaxBorrowAssets(collateralAfter, { maxLtv }) ?? 0n, loanAfter),
    },
  };
}
