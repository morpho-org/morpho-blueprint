import "server-only";

import { type Address, getAddress, type Hex, zeroAddress } from "viem";
import { descale, toRatio } from "@/common/data/adapters/amount";
import { assembleApyWithRewards } from "@/common/data/adapters/apy";
import { getTokenInfo, getTokenPriceUsd } from "@/common/data/rest/tokens";
import type { ChainInfo, TokenInfo } from "@/common/data/types";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import type { MarketInfo } from "@/modules/market/market.types";
import { type MerklRewardIndex, marketSupplyRewardApys } from "@/modules/reward/data/merklRewardApys";
import { composeMarketName } from "./adapters";

interface RestMarketRoot {
  chain_id: number;
  market_id: Hex;
  loan_token: Address;
  collateral_token: Address;
  lltv_wad: string;
}

interface RestMarketState {
  data: { total_supply_assets: string };
}

type ApyAverageKey = "6h" | "24h" | "7d" | "30d";

interface RestMarketApyAverages {
  data: { supply_apy_averages: Partial<Record<ApyAverageKey, number | null>> };
}

/**
 * The `MarketInfo` of each market, read from Core REST: params from the batched market list, then
 * per market its state and APY averages, and per token its metadata and price. A market REST does
 * not know, or whose loan token it cannot describe, is left out of the map. The chain's Merkl
 * reward index comes from the caller, which reads it once per chain. A loan token price the caller
 * already read (`knownPrices`, by checksummed address) is not read again.
 */
export async function getMarketInfos(
  chainId: number,
  chain: ChainInfo,
  marketIds: readonly Hex[],
  rewardIndex: Promise<MerklRewardIndex>,
  knownPrices: ReadonlyMap<Address, number | null> = new Map(),
): Promise<Map<string, MarketInfo>> {
  const result = new Map<string, MarketInfo>();
  if (marketIds.length === 0) return result;

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
    .filter((root) => root.chain_id === chainId);

  const tokenAddresses = new Set<Address>();
  for (const root of roots) {
    tokenAddresses.add(getAddress(root.loan_token));
    if (getAddress(root.collateral_token) !== zeroAddress) tokenAddresses.add(getAddress(root.collateral_token));
  }

  const [tokens, loanPrices, marketData, merklIndex] = await Promise.all([
    Promise.all([...tokenAddresses].map(async (address) => [address, await getTokenInfo(chainId, address)] as const)),
    Promise.all(
      [...new Set(roots.map((root) => getAddress(root.loan_token)))].map(async (address) => {
        const known = knownPrices.get(address);
        // A known `null` (no price) is an answer too: only an absent entry is read.
        return [address, known === undefined ? await getTokenPriceUsd(chainId, address) : known] as const;
      }),
    ),
    Promise.all(
      roots.map(async (root) => {
        const selector = restSelector(chainId, root.market_id);
        const [state, apy] = await Promise.all([
          fetchMorphoRestResource<RestMarketState>(`/v0/blue/markets/${selector}/state`),
          fetchMorphoRestResource<RestMarketApyAverages>(`/v0/blue/markets/${selector}/apy-averages`),
        ]);
        return [root.market_id.toLowerCase(), { state, apy }] as const;
      }),
    ),
    rewardIndex,
  ]);
  const tokenByAddress = new Map<Address, TokenInfo | null>(tokens);
  const priceByAddress = new Map<Address, number | null>(loanPrices);
  const dataById = new Map(marketData);

  for (const root of roots) {
    const loanAsset = tokenByAddress.get(getAddress(root.loan_token));
    const collateralAddress = getAddress(root.collateral_token);
    // An idle market has no collateral token.
    const collateralAsset = collateralAddress === zeroAddress ? null : tokenByAddress.get(collateralAddress);
    // A collateral token REST cannot describe is `null` here too: skip rather than show it as idle.
    if (!loanAsset || (collateralAddress !== zeroAddress && !collateralAsset)) {
      console.warn(`Market tokens not returned by the API, skipping the market: ${chainId}:${root.market_id}`);
      continue;
    }

    const { state, apy } = dataById.get(root.market_id.toLowerCase()) ?? { state: null, apy: null };
    const loanPriceUsd = priceByAddress.get(getAddress(root.loan_token)) ?? null;
    const averages = apy?.data.supply_apy_averages ?? {};
    // REST serves native APYs only: the current Merkl reward APRs are added to every window.
    const supplyRewards = marketSupplyRewardApys(merklIndex, root.market_id, getAddress(root.loan_token));
    const supplyApy = (key: ApyAverageKey) => assembleApyWithRewards(averages[key], supplyRewards);

    result.set(root.market_id.toLowerCase(), {
      marketId: root.market_id,
      chain,
      name: composeMarketName(collateralAsset?.symbol, loanAsset.symbol),
      isIdle: collateralAddress === zeroAddress,
      lltv: toRatio(root.lltv_wad),
      collateralAsset: collateralAsset ?? null,
      loanAsset,
      totalSupplied: {
        usd:
          state && loanPriceUsd != null
            ? descale(state.data.total_supply_assets, loanAsset.decimals) * loanPriceUsd
            : null,
      },
      supplyApy6h: supplyApy("6h"),
      supplyApy1d: supplyApy("24h"),
      supplyApy7d: supplyApy("7d"),
      supplyApy30d: supplyApy("30d"),
    });
  }

  return result;
}
