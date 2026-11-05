import "server-only";

import { cache } from "react";
import type { Address } from "viem";
import { getTokenMetadata, parseTokenDecimals } from "@/common/data/rest/tokens";
import type { RewardApy } from "@/common/data/types";
import { tryCatch } from "@/common/utils/tryCatch";
import { withDeadline } from "./deadline";
import { type MerklRewardIndex, rewardTokenChainId } from "./merklRewardApys";

// A reward label is not worth holding a page for: past this, Merkl's fields are shown.
const TOKEN_METADATA_TIMEOUT_MS = 1_000;

/**
 * One Core REST metadata read per reward token per render (day cache), bounded by a deadline.
 * `null` when Core does not know the token, fails, or is too slow.
 */
const getRewardTokenMetadata = cache(async (chainId: number, address: Address) => {
  const { data } = await tryCatch(
    withDeadline(getTokenMetadata(chainId, address, { quiet: true }), TOKEN_METADATA_TIMEOUT_MS, "Core token metadata"),
  );
  return data ?? null;
});

/**
 * The rewards a caller shows, with Core REST's symbol, name and decimals field by field, Merkl's
 * where Core has none. Only tokens of these rewards are read, not the whole chain index.
 */
export async function withRewardTokenMetadata(index: MerklRewardIndex, rewards: RewardApy[]): Promise<RewardApy[]> {
  return Promise.all(
    rewards.map(async (reward) => {
      const chainId = rewardTokenChainId(index, reward.asset.address);
      const core = chainId == null ? null : await getRewardTokenMetadata(chainId, reward.asset.address);
      if (!core) return reward;
      return {
        ...reward,
        asset: {
          ...reward.asset,
          symbol: core.symbol ?? reward.asset.symbol,
          name: core.name ?? reward.asset.name,
          decimals: parseTokenDecimals(core.decimals) ?? reward.asset.decimals,
        },
      };
    }),
  );
}
