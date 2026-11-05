import { AdaptiveCurveIrmLib, MarketUtils, MathLib } from "@morpho-org/blue-sdk";
import { formatUnits, getAddress, type Hex } from "viem";
import { descale, toAmount, toAmountWithPrice, toBigInt, toRatio } from "@/common/data/adapters/amount";
import { assembleApy, toRewardApys } from "@/common/data/adapters/apy";
import { toChainInfo, toTokenInfo } from "@/common/data/adapters/entity";
import { type DataPoint, descaleSeries, zipTimeseries } from "@/common/data/adapters/timeseries";
import type { Apy, ChainInfo, CuratorInfo, RewardApy, TokenInfo } from "@/common/data/types";
import { numberToString } from "@/common/utils/format";
import type { Erc4626VaultProtocol } from "@/config/vault-protocol";
import type { MarketInfoFragmentFragment, MarketSummaryFragmentFragment } from "@/generated/gql/morpho/graphql";
import type {
  IrmCurvePoint,
  MarketHistoricalEntry,
  MarketInfo,
  MarketSummary,
  MarketVaultAllocation,
} from "@/modules/market/market.types";
import type { BigIntish } from "@/morpho-types";

/**
 * AdaptiveCurveIRM target utilization. Not exposed by the API (`Market.targetBorrowUtilization` is
 * deprecated and hardcodes 90% anyway); it is a protocol constant.
 */
export const ADAPTIVE_CURVE_IRM_TARGET_UTILIZATION = 0.9;

/** The API exposes no market name; compose one from the asset symbols, as app.morpho.org does. */
export function composeMarketName(collateralSymbol: string | null | undefined, loanSymbol: string): string {
  return collateralSymbol ? `${collateralSymbol} / ${loanSymbol}` : `Idle ${loanSymbol}`;
}

/**
 * Not exposed by the API. Derived from the LLTV, as Morpho Blue does:
 * `LIF = min(1.15, 1 / (0.3 * lltv + 0.7))`, and the penalty is `LIF - 1`.
 */
export function computeLiquidationPenalty(lltvWad: BigIntish | null | undefined): number {
  const lltv = Number(formatUnits(toBigInt(lltvWad), 18));
  const liquidationIncentiveFactor = Math.min(1.15, 1 / (0.3 * lltv + 0.7));
  return liquidationIncentiveFactor - 1;
}

/**
 * The oracle price (`/v0/oracles/{oracle}/state`) is one collateral unit in loan-asset units,
 * scaled by `36 + loanDecimals - collateralDecimals`. `raw` is passed straight to the blue-sdk math helpers
 * (which expect the 1e36-scaled oracle price), `formatted` is the human-readable price.
 */
export function toCollateralPriceInLoanAsset(
  price: BigIntish | null | undefined,
  loanDecimals: number,
  collateralDecimals: number,
): { raw: string; formatted: string } | null {
  if (price == null) return null;
  const raw = toBigInt(price);
  const scale = 36 + Math.round(loanDecimals) - Math.round(collateralDecimals);
  return { raw: raw.toString(), formatted: formatUnits(raw, scale) };
}

export function toMarketInfo(market: MarketInfoFragmentFragment): MarketInfo {
  const state = market.state;
  const collateralAsset = market.collateralAsset ? toTokenInfo(market.collateralAsset) : null;
  const loanAsset = toTokenInfo(market.loanAsset);
  const rewards = toRewardApys(state?.rewards, "supply");

  return {
    marketId: market.marketId,
    chain: toChainInfo(market.chain),
    name: composeMarketName(collateralAsset?.symbol, loanAsset.symbol),
    // A market with no collateral asset is an idle market.
    isIdle: collateralAsset === null,
    lltv: toRatio(market.lltv),
    collateralAsset,
    loanAsset,
    totalSupplied: { usd: state?.supplyAssetsUsd ?? null },
    supplyApy6h: assembleApy({
      apyExcludingRewards: state?.avgSupplyApy,
      netApy: state?.avgNetSupplyApy,
      rewards,
    }),
    supplyApy1d: assembleApy({
      apyExcludingRewards: state?.dailySupplyApy,
      netApy: state?.dailyNetSupplyApy,
      rewards,
    }),
    supplyApy7d: assembleApy({
      apyExcludingRewards: state?.weeklySupplyApy,
      netApy: state?.weeklyNetSupplyApy,
      rewards,
    }),
    supplyApy30d: assembleApy({
      apyExcludingRewards: state?.monthlySupplyApy,
      netApy: state?.monthlyNetSupplyApy,
      rewards,
    }),
  };
}

export function toMarketSummary(market: MarketSummaryFragmentFragment): MarketSummary {
  const state = market.state;
  const collateralAsset = market.collateralAsset ? toTokenInfo(market.collateralAsset) : null;
  const loanAsset = toTokenInfo(market.loanAsset);
  const rewards = toRewardApys(state?.rewards, "borrow");

  return {
    chain: toChainInfo(market.chain),
    name: composeMarketName(collateralAsset?.symbol, loanAsset.symbol),
    marketId: market.marketId,
    totalBorrowed: toAmount(state?.borrowAssets, loanAsset.decimals, state?.borrowAssetsUsd),
    collateralAsset,
    loanAsset,
    lltv: toRatio(market.lltv),
    borrowApy6h: assembleApy({
      apyExcludingRewards: state?.avgBorrowApy,
      netApy: state?.avgNetBorrowApy,
      rewards,
    }),
    borrowApy1d: assembleApy({
      apyExcludingRewards: state?.dailyBorrowApy,
      netApy: state?.dailyNetBorrowApy,
      rewards,
    }),
    borrowApy7d: assembleApy({
      apyExcludingRewards: state?.weeklyBorrowApy,
      netApy: state?.weeklyNetBorrowApy,
      rewards,
    }),
    borrowApy30d: assembleApy({
      apyExcludingRewards: state?.monthlyBorrowApy,
      netApy: state?.monthlyNetBorrowApy,
      rewards,
    }),
  };
}

/** Core REST's `apy-averages` window keys, as the market list reads them. */
export type RestApyAverageKey = "6h" | "24h" | "7d" | "30d";

/**
 * A borrow APY from a REST native average and the current Merkl borrow reward APRs. Rewards lower
 * what a borrower pays, so `total` is the native rate minus their sum (GraphQL's `netBorrowApy`).
 */
function toRestBorrowApy(nativeApy: number | null | undefined, rewards: RewardApy[]): Apy {
  const afterFees = nativeApy ?? 0;
  return { afterFees, total: rewards.reduce((sum, reward) => sum - reward.apr, afterFees), rewards };
}

/** One borrow-table row from Core REST reads. `loanPriceUsd` null leaves the USD value unknown. */
export function toRestMarketSummary(source: {
  marketId: Hex;
  chain: ChainInfo;
  lltvWad: string;
  collateralAsset: TokenInfo | null;
  loanAsset: TokenInfo;
  totalBorrowAssets: string;
  loanPriceUsd: number | null;
  borrowApyAverages: Partial<Record<RestApyAverageKey, number | null>>;
  borrowRewards: RewardApy[];
}): MarketSummary {
  const { borrowApyAverages: averages, borrowRewards: rewards } = source;
  return {
    chain: source.chain,
    name: composeMarketName(source.collateralAsset?.symbol, source.loanAsset.symbol),
    marketId: source.marketId,
    totalBorrowed: toAmountWithPrice(source.totalBorrowAssets, source.loanAsset.decimals, source.loanPriceUsd),
    collateralAsset: source.collateralAsset,
    loanAsset: source.loanAsset,
    lltv: toRatio(source.lltvWad),
    borrowApy6h: toRestBorrowApy(averages["6h"], rewards),
    borrowApy1d: toRestBorrowApy(averages["24h"], rewards),
    borrowApy7d: toRestBorrowApy(averages["7d"], rewards),
    borrowApy30d: toRestBorrowApy(averages["30d"], rewards),
  };
}

/**
 * The AdaptiveCurveIRM curve at the current rate at target, on 101 utilization points, computed
 * with blue-sdk as the contract does (no elapsed time). Supply APY follows `Market.getSupplyApy`.
 * Empty when Core serves no rate at target (the market's IRM is not the AdaptiveCurveIRM).
 */
export function computeIrmCurve(
  rateAtTargetWad: BigIntish | null | undefined,
  feeWad: BigIntish | null | undefined,
  numberOfPoints = 100,
): IrmCurvePoint[] {
  if (rateAtTargetWad == null) return [];
  const rateAtTarget = toBigInt(rateAtTargetWad);
  const fee = toBigInt(feeWad);
  return Array.from({ length: numberOfPoints + 1 }, (_, i) => {
    const utilization = (MathLib.WAD * BigInt(i)) / BigInt(numberOfPoints);
    const { endBorrowRate } = AdaptiveCurveIrmLib.getBorrowRate(utilization, rateAtTarget, 0n);
    const supplyRate = MathLib.wMulUp(MathLib.wMulDown(endBorrowRate, utilization), MathLib.WAD - fee);
    return {
      utilization: i / numberOfPoints,
      borrowApy: MarketUtils.rateToApy(endBorrowRate),
      supplyApy: MarketUtils.rateToApy(supplyRate),
    };
  });
}

/** Borrow over supply, 0 for an empty market. */
export function computeUtilization(totalSupplyAssets: BigIntish, totalBorrowAssets: BigIntish): number {
  const supply = toBigInt(totalSupplyAssets);
  return supply > 0n ? Number(formatUnits((toBigInt(totalBorrowAssets) * MathLib.WAD) / supply, 18)) : 0;
}

/** One configured vault's position on the market, as read from Core REST. */
export interface RestMarketSupplier {
  protocol: Erc4626VaultProtocol;
  vaultAddress: string;
  name: string;
  curatorAddress: string | null;
  curator: CuratorInfo | null;
  supplyAssets: bigint;
  /** Vault V2 allocations are not share-denominated: "0". */
  supplyShares: string;
  supplyCap: bigint;
}

/**
 * A supplier-table row. The vault's asset is the market's loan token, so it is priced and described
 * with it; the supply share is against the market's total supply.
 */
export function toMarketVaultAllocation(
  supplier: RestMarketSupplier,
  market: { chain: ChainInfo; loanAsset: TokenInfo; loanPriceUsd: number | null; totalSupplyAssets: BigIntish },
): MarketVaultAllocation {
  const { decimals } = market.loanAsset;
  const total = toBigInt(market.totalSupplyAssets);
  return {
    protocol: supplier.protocol,
    vault: {
      vaultAddress: getAddress(supplier.vaultAddress),
      name: supplier.name,
      curatorAddress: supplier.curatorAddress ? getAddress(supplier.curatorAddress) : null,
      asset: market.loanAsset,
      chain: market.chain,
      metadata: { curator: supplier.curator },
    },
    enabled: supplier.supplyCap > 0n,
    position: {
      supplyAmount: toAmountWithPrice(supplier.supplyAssets, decimals, market.loanPriceUsd),
      supplyShares: supplier.supplyShares,
    },
    supplyCap: toAmountWithPrice(supplier.supplyCap, decimals, market.loanPriceUsd),
    marketSupplyShare: total > 0n ? descale(supplier.supplyAssets, decimals) / descale(total, decimals) : 0,
  };
}

/** Joins the market chart series into the bucket rows the chart expects. */
export function toMarketHistoricalEntries(
  series: {
    supplyAssets: readonly { x: number; y: BigIntish | null }[];
    supplyAssetsUsd: readonly DataPoint[];
    borrowAssets: readonly { x: number; y: BigIntish | null }[];
    borrowAssetsUsd: readonly DataPoint[];
    collateralAssets: readonly { x: number; y: BigIntish | null }[];
    collateralAssetsUsd: readonly DataPoint[];
    borrowApy1d: readonly DataPoint[];
    netBorrowApy1d: readonly DataPoint[];
    borrowApy7d: readonly DataPoint[];
    netBorrowApy7d: readonly DataPoint[];
    borrowApy30d: readonly DataPoint[];
    netBorrowApy30d: readonly DataPoint[];
  },
  loanDecimals: number,
  collateralDecimals: number,
): MarketHistoricalEntry[] {
  return zipTimeseries(
    {
      supply: descaleSeries(series.supplyAssets, loanDecimals),
      supplyUsd: series.supplyAssetsUsd,
      borrow: descaleSeries(series.borrowAssets, loanDecimals),
      borrowUsd: series.borrowAssetsUsd,
      collateral: descaleSeries(series.collateralAssets, collateralDecimals),
      collateralUsd: series.collateralAssetsUsd,
      base1d: series.borrowApy1d,
      total1d: series.netBorrowApy1d,
      base7d: series.borrowApy7d,
      total7d: series.netBorrowApy7d,
      base30d: series.borrowApy30d,
      total30d: series.netBorrowApy30d,
    },
    (bucketTimestamp, values) => ({
      bucketTimestamp,
      totalSupplied: { formatted: numberToString(values.supply ?? 0), usd: values.supplyUsd },
      totalBorrowed: { formatted: numberToString(values.borrow ?? 0), usd: values.borrowUsd },
      totalCollateral: { formatted: numberToString(values.collateral ?? 0), usd: values.collateralUsd },
      // Kept null where the upstream series has no sample (a market younger than the window),
      // so the chart shows a gap instead of a spurious 0% line — same rule as the vault chart.
      borrowApy1d: { base: values.base1d ?? null, total: values.total1d ?? null },
      borrowApy7d: { base: values.base7d ?? null, total: values.total7d ?? null },
      borrowApy30d: { base: values.base30d ?? null, total: values.total30d ?? null },
    }),
  );
}
