import { type MarketId, MathLib } from "@morpho-org/blue-sdk";
import type { SimulationState } from "@morpho-org/simulation-sdk";

/**
 * The most the borrow bundle can pull into `marketId` through the Public Allocator V1, from the
 * vaults loaded in `state`. It runs the same two passes as `populateBundle` in
 * `@morpho-org/bundler-sdk-viem`: first the withdrawals that keep every source market under the
 * SDK's default withdrawal utilization, then, from the state they leave, the withdrawals that
 * empty the source markets up to 100% utilization. A borrow up to the market's liquidity plus this
 * amount is what the bundle can fill.
 */
export function computePublicAllocatorV1Liquidity(state: SimulationState, marketId: MarketId): bigint {
  const friendly = state.getMarketPublicReallocations(marketId, { enabled: true });
  const full = friendly.data.getMarketPublicReallocations(marketId, {
    enabled: true,
    defaultMaxWithdrawalUtilization: MathLib.WAD,
    maxWithdrawalUtilization: {},
  });
  return [...friendly.withdrawals, ...full.withdrawals].reduce((total, { assets }) => total + assets, 0n);
}
