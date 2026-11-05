import type { Apy, RewardApy } from "@/common/data/types";

/**
 * A REST native APY plus the current Merkl reward APRs. REST serves no rewards-inclusive APY, so
 * `total` is the windowed native average plus the instantaneous reward APRs.
 */
export function assembleApyWithRewards(nativeApy: number | null | undefined, rewards: RewardApy[]): Apy {
  const afterFees = nativeApy ?? 0;
  return { afterFees, total: rewards.reduce((sum, reward) => sum + reward.apr, afterFees), rewards };
}
