import "server-only";

import { cache } from "react";
import { type Address, getAddress, type Hex, zeroAddress } from "viem";
import { toChainInfoById } from "@/common/data/adapters/entity";
import { getTokenInfo, getTokenPriceUsd } from "@/common/data/rest/tokens";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import type { MarketSummary } from "@/modules/market/market.types";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { marketBorrowRewardApys } from "@/modules/reward/data/merklRewardApys";
import { withRewardTokenMetadata } from "@/modules/reward/data/rewardTokenMetadata";
import { type RestApyAverageKey, toRestMarketSummary } from "./adapters";
import { getSupportedMarketIds } from "./getSupportedMarketIds";

export type { MarketSummary };

interface RestMarketRoot {
  chain_id: number;
  market_id: Hex;
  loan_token: Address;
  collateral_token: Address;
  lltv_wad: string;
}

interface RestMarketState {
  data: { total_borrow_assets: string };
}

interface RestMarketApyAverages {
  data: { borrow_apy_averages: Partial<Record<RestApyAverageKey, number | null>> | null };
}

/** Memoizes a per-token read within one call, so tokens shared by several markets are read once. */
function once<R>(load: (chainId: number, address: Address) => Promise<R>) {
  const reads = new Map<string, Promise<R>>();
  return (chainId: number, address: Address) => {
    const key = `${chainId}:${address}`;
    let read = reads.get(key);
    if (!read) {
      read = load(chainId, address);
      reads.set(key, read);
    }
    return read;
  };
}

async function getChainMarketSummaries(chainId: number, marketIds: readonly Hex[]): Promise<MarketSummary[]> {
  const rewardIndex = getMerklRewardIndex(chainId);
  const roots = (
    await Promise.all(
      chunk([...new Set(marketIds)]).map((ids) =>
        // Market params never change.
        fetchAllMorphoRestPages<RestMarketRoot>(
          "/v0/blue/markets",
          { chain_id: [chainId], market_id: ids },
          { revalidate: SECONDS_PER_DAY },
        ),
      ),
    )
  )
    .flat()
    // The borrow table shows no idle market (no collateral), so its state is never read.
    .filter((root) => root.chain_id === chainId && getAddress(root.collateral_token) !== zeroAddress)
    // The table's default order, as GraphQL served it: market id descending within a chain.
    .sort((a, b) => (a.market_id.toLowerCase() < b.market_id.toLowerCase() ? 1 : -1));

  const tokenOf = once(getTokenInfo);
  const priceOf = once(getTokenPriceUsd);
  const chain = toChainInfoById(chainId);

  // Every read starts at once: the REST client caps the calls in flight. Any failure but a 404
  // rejects the list, so a rate-limited render fails and Next keeps serving the last good page.
  const rows = await Promise.all(
    roots.map(async (root) => {
      const selector = restSelector(chainId, root.market_id);
      const loanToken = getAddress(root.loan_token);
      const [state, apy, loanAsset, collateralAsset, loanPriceUsd, merkl] = await Promise.all([
        fetchMorphoRestResource<RestMarketState>(`/v0/blue/markets/${selector}/state`),
        fetchMorphoRestResource<RestMarketApyAverages>(`/v0/blue/markets/${selector}/apy-averages`),
        tokenOf(chainId, loanToken),
        tokenOf(chainId, getAddress(root.collateral_token)),
        priceOf(chainId, loanToken),
        rewardIndex,
      ]);
      if (!state || !loanAsset || !collateralAsset) {
        console.warn(`Market not fully known to the API, skipping it: ${selector}`);
        return null;
      }
      // Reward token metadata is read for the shown markets only.
      const borrowRewards = await withRewardTokenMetadata(
        merkl,
        marketBorrowRewardApys(merkl, root.market_id, loanToken),
      );
      return toRestMarketSummary({
        marketId: root.market_id,
        chain,
        lltvWad: root.lltv_wad,
        collateralAsset,
        loanAsset,
        totalBorrowAssets: state.data.total_borrow_assets,
        loanPriceUsd,
        borrowApyAverages: apy?.data.borrow_apy_averages ?? {},
        borrowRewards,
      });
    }),
  );
  return rows.filter((row) => row !== null);
}

/**
 * The borrow table, read from Core REST: per chain the batched market params, then per market its
 * state and APY averages, per token its metadata and per loan token its price, plus the chain's
 * Merkl borrow rewards. Idle markets are left out.
 */
export const getMarketSummaries = cache(async (): Promise<MarketSummary[]> => {
  const supportedMarketIds = await getSupportedMarketIds();
  const byChain = Object.entries(supportedMarketIds)
    .map(([chainId, ids]) => [Number.parseInt(chainId), Array.from(ids)] as const)
    .filter(([, ids]) => ids.length > 0);

  const perChain = await Promise.all(byChain.map(([chainId, ids]) => getChainMarketSummaries(chainId, ids)));
  return perChain.flat();
});
