import "server-only";

import { cache } from "react";
import { type Address, getAddress, type Hex, zeroAddress } from "viem";
import { toAmountWithPrice, toBigInt } from "@/common/data/adapters/amount";
import { toChainInfoById } from "@/common/data/adapters/entity";
import { getTokenInfo, getTokenPriceUsd } from "@/common/data/rest/tokens";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { redactError } from "@/common/utils/redactError";
import { tryCatch } from "@/common/utils/tryCatch";
import type { SupportedChainId } from "@/config/types";
import type { Market, MarketNonIdle } from "@/modules/market/market.types";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { marketBorrowRewardApys } from "@/modules/reward/data/merklRewardApys";
import { withRewardTokenMetadata } from "@/modules/reward/data/rewardTokenMetadata";
import {
  ADAPTIVE_CURVE_IRM_TARGET_UTILIZATION,
  computeIrmCurve,
  computeLiquidationPenalty,
  computeUtilization,
  type RestApyAverageKey,
  toCollateralPriceInLoanAsset,
  toMarketVaultAllocation,
  toRestMarketSummary,
} from "./adapters";
import { getMarketHistory } from "./getMarketHistory";
import { getMarketSupplyingVaults } from "./getMarketSupplyingVaults";

interface RestMarketRoot {
  data: {
    loan_token: Address;
    collateral_token: Address;
    oracle_address: Address;
    irm_address: Address;
    lltv_wad: string;
  };
}

interface RestMarketState {
  data: {
    total_supply_assets: string;
    total_borrow_assets: string;
    fee_wad: string;
    rate_at_target_per_second_wad: string | null;
  };
}

interface RestMarketLiquidity {
  // `reallocatable_liquidity`: what the Public Allocator V2 can move in from vaults V2.
  data: { market_liquidity: string; reallocatable_liquidity: string | null };
}

interface RestPublicAllocatorVaults {
  data: { vault_address: Address }[];
}

/** Same bound as the Actions API: past it, the on-chain reallocation read is too large for one borrow. */
const MAX_PUBLIC_ALLOCATOR_VAULTS = 64;

interface RestMarketApyAverages {
  data: { borrow_apy_averages: Partial<Record<RestApyAverageKey, number | null>> };
}

interface RestOracleState {
  data: { price: string | null };
}

export type { Market, MarketNonIdle };

export function isNonIdleMarket(market: Market | null): market is MarketNonIdle {
  return !!market && market.isIdle === false && !!market.collateralAsset;
}

/**
 * The market page, from Core REST: params, state, liquidity, borrow APY averages and the oracle
 * price, token metadata and prices, the chain's Merkl borrow rewards, the vaults that supply the
 * market (the configured ones, plus every vault V2 the Blueprint API lists when it is on), the
 * vaults V2 the Public Allocator V2 can reallocate from, and the chart history. Throws when Core
 * does not know the market.
 */
export const getMarket = cache(async (chainId: SupportedChainId, marketId: Hex): Promise<Market> => {
  const selector = restSelector(chainId, marketId);
  // Market params never change.
  const root = await fetchMorphoRestResource<RestMarketRoot>(`/v0/blue/markets/${selector}`, undefined, {
    revalidate: SECONDS_PER_DAY,
  });
  if (!root) throw new Error(`Market not found: ${chainId}:${marketId}`);

  const loanAddress = getAddress(root.data.loan_token);
  const collateralAddress = getAddress(root.data.collateral_token);
  const oracleAddress = getAddress(root.data.oracle_address);
  // An idle market has no collateral token, and no oracle to read.
  const isIdle = collateralAddress === zeroAddress;

  const [
    state,
    liquidity,
    publicAllocatorVaultAddresses,
    apy,
    oracle,
    loanAsset,
    collateralAsset,
    loanPriceUsd,
    collateralPriceUsd,
    rewardIndex,
  ] = await Promise.all([
    fetchMorphoRestResource<RestMarketState>(`/v0/blue/markets/${selector}/state`),
    fetchMorphoRestResource<RestMarketLiquidity>(`/v0/blue/markets/${selector}/liquidity`),
    // An idle market has no borrow to fund.
    isIdle ? [] : getPublicAllocatorVaultAddresses(chainId, marketId),
    fetchMorphoRestResource<RestMarketApyAverages>(`/v0/blue/markets/${selector}/apy-averages`),
    oracleAddress === zeroAddress
      ? null
      : fetchMorphoRestResource<RestOracleState>(`/v0/oracles/${restSelector(chainId, oracleAddress)}/state`),
    getTokenInfo(chainId, loanAddress),
    isIdle ? null : getTokenInfo(chainId, collateralAddress),
    getTokenPriceUsd(chainId, loanAddress),
    isIdle ? null : getTokenPriceUsd(chainId, collateralAddress),
    getMerklRewardIndex(chainId),
  ]);
  if (!state) throw new Error(`Market not found: ${chainId}:${marketId}`);
  // Formatting with a guessed scale would misstate every amount by orders of magnitude.
  if (!loanAsset || (!isIdle && !collateralAsset)) {
    throw new Error(`Market tokens not returned by the API: ${chainId}:${marketId}`);
  }

  const chain = toChainInfoById(chainId);
  const loanDecimals = loanAsset.decimals;
  const { total_supply_assets: totalSupplyAssets, total_borrow_assets: totalBorrowAssets } = state.data;

  const [suppliers, historical, borrowRewards] = await Promise.all([
    getMarketSupplyingVaults(chainId, marketId, loanAddress),
    getMarketHistory(
      chainId,
      marketId,
      { address: loanAddress, decimals: loanDecimals },
      collateralAsset ? { address: collateralAddress, decimals: collateralAsset.decimals } : null,
    ),
    // As the borrow table labels them: Core's token metadata, Merkl's where Core has none.
    withRewardTokenMetadata(rewardIndex, marketBorrowRewardApys(rewardIndex, marketId, loanAddress)),
  ]);

  const summary = toRestMarketSummary({
    marketId,
    chain,
    lltvWad: root.data.lltv_wad,
    collateralAsset,
    loanAsset,
    totalBorrowAssets,
    loanPriceUsd,
    borrowApyAverages: apy?.data.borrow_apy_averages ?? {},
    borrowRewards,
  });

  // Without a liquidity read, what the market itself holds is still supply minus borrow.
  const marketLiquidity = toBigInt(
    liquidity?.data.market_liquidity ?? toBigInt(totalSupplyAssets) - toBigInt(totalBorrowAssets),
  );
  // The borrow reallocates only from the candidates it is given: without them, Core's figure is out of reach.
  const publicAllocatorLiquidity =
    publicAllocatorVaultAddresses.length > 0 ? toBigInt(liquidity?.data.reallocatable_liquidity ?? 0) : 0n;

  return {
    ...summary,
    isIdle,
    totalSupplied: toAmountWithPrice(totalSupplyAssets, loanDecimals, loanPriceUsd),
    liquidityInMarket: toAmountWithPrice(marketLiquidity, loanDecimals, loanPriceUsd),
    publicAllocatorLiquidity: toAmountWithPrice(publicAllocatorLiquidity, loanDecimals, loanPriceUsd),
    availableToBorrow: toAmountWithPrice(marketLiquidity + publicAllocatorLiquidity, loanDecimals, loanPriceUsd),
    publicAllocatorVaultAddresses,
    collateralAsset: collateralAsset ? { ...collateralAsset, priceUsd: collateralPriceUsd } : null,
    loanAsset: { ...loanAsset, priceUsd: loanPriceUsd },
    vaultAllocations: suppliers.map((supplier) =>
      toMarketVaultAllocation(supplier, { chain, loanAsset, loanPriceUsd, totalSupplyAssets }),
    ),
    utilization: computeUtilization(totalSupplyAssets, totalBorrowAssets),
    irm: {
      address: getAddress(root.data.irm_address),
      targetUtilization: ADAPTIVE_CURVE_IRM_TARGET_UTILIZATION,
      curve: computeIrmCurve(state.data.rate_at_target_per_second_wad, state.data.fee_wad),
    },
    liquidationPenalty: computeLiquidationPenalty(root.data.lltv_wad),
    oracleAddress: oracleAddress === zeroAddress ? null : oracleAddress,
    collateralPriceInLoanAsset: toCollateralPriceInLoanAsset(
      oracle?.data.price,
      loanDecimals,
      collateralAsset?.decimals ?? 0,
    ),
    historical,
  };
});

/**
 * The vaults V2 the Public Allocator V2 can move liquidity from into the market: the borrow's
 * reallocation candidates, as the Actions API reads them. Deduplicated (a vault appears once per
 * adapter) and sorted. A failed read degrades to none, so the page shows direct liquidity only.
 */
async function getPublicAllocatorVaultAddresses(chainId: SupportedChainId, marketId: Hex): Promise<Address[]> {
  const { data, error } = await tryCatch(
    fetchMorphoRestResource<RestPublicAllocatorVaults>(
      `/v0/blue/markets/${restSelector(chainId, marketId)}/public-allocator-vaults`,
    ),
  );
  if (error) {
    console.warn(`Public Allocator vaults read failed for ${chainId}:${marketId}: ${redactError(error)}`);
    return [];
  }
  const addresses = [...new Set((data?.data ?? []).map((row) => getAddress(row.vault_address)))].sort();
  return addresses.slice(0, MAX_PUBLIC_ALLOCATOR_VAULTS);
}
