import { getAddress, zeroAddress } from "viem";
import { descale, toAmount, toBigInt } from "@/common/data/adapters/amount";
import { assembleApy, assembleApyWithRewards, toApyAverages, toRewardApys } from "@/common/data/adapters/apy";
import { toChainInfo, toChainInfoById, toCuratorInfo, toTokenInfo } from "@/common/data/adapters/entity";
import { type DataPoint, descaleSeries, zipTimeseries } from "@/common/data/adapters/timeseries";
import type { RestToken } from "@/common/data/rest/tokens";
import type { ChainInfo, CuratorInfo, RewardApy } from "@/common/data/types";
import { numberToString } from "@/common/utils/format";
import { APP_CONFIG } from "@/config";
import type {
  MorphoVaultV1CollateralFragmentFragment,
  MorphoVaultV1DetailsFragmentFragment,
  MorphoVaultV1SummaryFragmentFragment,
  VaultAllocationFragmentFragment,
  VaultCollateralAllocationFragmentFragment,
} from "@/generated/gql/morpho/graphql";
import { toMarketInfo } from "@/modules/market/data/adapters";
import type {
  MorphoVaultV1,
  MorphoVaultV1Summary,
  MorphoVaultV2,
  MorphoVaultV2Summary,
  VaultCollateralAllocation,
  VaultHistoricalEntry,
  VaultMarketAllocation,
} from "@/modules/vault/vault.types";
import type { BigIntish } from "@/morpho-types";
import type { VaultV2Details } from "./getVaultV2Details";

/**
 * The shape an adapter produces, before `normalizeVault` applies the vault config: `isHidden` is
 * not known yet and the chain id has not been narrowed to a configured chain.
 */
export type Adapted<T> = Omit<T, "isHidden" | "chain"> & { chain: ChainInfo };

function priceOf(asset: { price?: { usd: number } | null }): number | null {
  return asset.price?.usd ?? null;
}

function usdOf(raw: BigIntish | null | undefined, decimals: number, priceUsd: number | null): number | null {
  return priceUsd == null ? null : descale(raw, decimals) * priceUsd;
}

function share(part: BigIntish | null | undefined, whole: BigIntish | null | undefined, decimals: number): number {
  const total = descale(whole, decimals);
  return total > 0 ? descale(part, decimals) / total : 0;
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V1 allocations                                                                           */
/* -------------------------------------------------------------------------------------------- */

export function toVaultMarketAllocations(
  allocations: readonly VaultAllocationFragmentFragment[],
  vaultTotalAssets: BigIntish | null | undefined,
  assetDecimals: number,
): VaultMarketAllocation[] {
  return allocations.map((allocation) => ({
    // Whisk exposed `enabled` directly; a non-zero supply cap is the equivalent condition.
    enabled: toBigInt(allocation.supplyCap) > 0n,
    vaultSupplyShare: share(allocation.supplyAssets, vaultTotalAssets, assetDecimals),
    position: {
      supplyAmount: toAmount(allocation.supplyAssets, assetDecimals, allocation.supplyAssetsUsd),
      supplyShares: toBigInt(allocation.supplyShares).toString(),
    },
    supplyCap: toAmount(allocation.supplyCap, assetDecimals, allocation.supplyCapUsd),
    market: toMarketInfo(allocation.market),
  }));
}

function toVaultCollateralAllocations(
  allocations: readonly VaultCollateralAllocationFragmentFragment[],
  vaultTotalAssets: BigIntish | null | undefined,
  assetDecimals: number,
): VaultCollateralAllocation[] {
  return allocations.map((allocation) => ({
    enabled: toBigInt(allocation.supplyCap) > 0n,
    vaultSupplyShare: share(allocation.supplyAssets, vaultTotalAssets, assetDecimals),
    position: { supplyAmount: { usd: allocation.supplyAssetsUsd ?? null } },
    market: {
      collateralAsset: allocation.market.collateralAsset
        ? {
            icon: allocation.market.collateralAsset.logoURI ?? null,
            name: allocation.market.collateralAsset.name,
            symbol: allocation.market.collateralAsset.symbol,
          }
        : null,
    },
  }));
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V1                                                                                       */
/* -------------------------------------------------------------------------------------------- */

type MorphoVaultV1Base = Omit<Adapted<MorphoVaultV1Summary>, "marketAllocations">;

function toMorphoVaultV1Base(vault: MorphoVaultV1SummaryFragmentFragment): MorphoVaultV1Base {
  const asset = toTokenInfo(vault.asset);
  const state = vault.state;
  const curator = state?.curators?.[0];

  return {
    __typename: "MorphoVault",
    chain: toChainInfo(vault.chain),
    vaultAddress: getAddress(vault.address),
    name: vault.name,
    asset: { ...asset, priceUsd: priceOf(vault.asset) },
    totalAssets: toAmount(state?.totalAssets, asset.decimals, state?.totalAssetsUsd),
    apy: assembleApy({
      netApy: state?.avgNetApy,
      apyExcludingRewards: state?.avgNetApyExcludingRewards,
      rewards: toRewardApys(state?.allRewards, "supply"),
    }),
    metadata: {
      description: vault.metadata?.description ?? null,
      curator: toCuratorInfo(curator),
    },
    // Native `Curator.state.aum`, replacing the previous name-matched join against a second query.
    curatorAum: curator?.state?.aum,
  };
}

export function toMorphoVaultV1Summary(
  vault: MorphoVaultV1SummaryFragmentFragment & MorphoVaultV1CollateralFragmentFragment,
): Adapted<MorphoVaultV1Summary> {
  const decimals = Math.round(vault.asset.decimals);
  return {
    ...toMorphoVaultV1Base(vault),
    marketAllocations: toVaultCollateralAllocations(vault.state?.allocation ?? [], vault.state?.totalAssets, decimals),
  };
}

export function toMorphoVaultV1Details(
  vault: MorphoVaultV1SummaryFragmentFragment & MorphoVaultV1DetailsFragmentFragment,
): Adapted<Omit<MorphoVaultV1, "historical">> {
  const decimals = Math.round(vault.asset.decimals);
  const state = vault.state;

  return {
    ...toMorphoVaultV1Base(vault),
    marketAllocations: toVaultMarketAllocations(state?.allocation ?? [], state?.totalAssets, decimals),
    totalLiquidity: { usd: vault.liquidity?.usd ?? null },
    apyAverages: toApyAverages(state),
    performanceFeeRaw: state?.fee ?? 0,
    feeRecipientAddress: state?.feeRecipient ? getAddress(state.feeRecipient) : null,
    ownerAddress: getAddress(state?.owner ?? zeroAddress),
    curatorAddress: getAddress(state?.curator ?? zeroAddress),
    guardianAddress: getAddress(state?.guardian ?? zeroAddress),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V2                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** Core REST's reads behind one vault V2 summary, joined by `getVaultSummaries` and `getVaultV2Summary`. */
export interface RestVaultV2SummarySource {
  chainId: number;
  /** `/v0/vaults-v2/{vault}`. */
  /** Core REST serves the names and symbols as nullable. */
  root: {
    address: string;
    name: string | null;
    asset: { address: string; name: string | null; symbol: string | null };
  };
  /** Already checked to be a uint8. */
  decimals: number;
  /** `/v1/vaults-v2/{vault}/state`: accrued as of the last indexed block. */
  totalAssets: string;
  /** `/v1/vaults-v2/{vault}/apy-averages` over `APP_CONFIG.apyWindow`, net of fees, no rewards. */
  apy: number | null;
  /** Current Merkl reward APRs, one per token; empty when Merkl is down. */
  rewards: RewardApy[];
  token: RestToken | null;
  priceUsd: number | null;
  curator: CuratorInfo | null;
  description: string | null;
}

/**
 * `total` is the native APY plus the current Merkl reward APRs. Curator AUM
 * has no production route, so it stays unset and the table hides it. The exposure tooltip only
 * expands MetaMorpho adapters, which REST summaries do not read, so `allocations` is empty.
 */
export function toRestVaultV2Summary(source: RestVaultV2SummarySource): Adapted<MorphoVaultV2Summary> {
  const { root, token, decimals, priceUsd } = source;
  // The earn page calls string methods on these: a null would fail the whole page, not one row.
  const assetName = token?.name ?? root.asset.name;
  const assetSymbol = token?.symbol ?? root.asset.symbol ?? assetName ?? "UNKNOWN";
  return {
    __typename: "MorphoVaultV2",
    chain: toChainInfoById(source.chainId),
    vaultAddress: getAddress(root.address),
    name: root.name ?? getAddress(root.address),
    asset: {
      ...toTokenInfo({
        address: root.asset.address,
        name: assetName ?? assetSymbol,
        symbol: assetSymbol,
        decimals,
        logoURI: token?.logo_uri ?? null,
        tags: token?.tags,
      }),
      priceUsd,
    },
    totalAssets: toAmount(source.totalAssets, decimals, usdOf(source.totalAssets, decimals, priceUsd)),
    apy: assembleApyWithRewards(source.apy, source.rewards),
    metadata: { description: source.description, curator: source.curator },
    curatorAum: undefined,
    allocations: [],
  };
}

/**
 * The vault page's vault V2: the header fields from the REST summary, every detail field (fees,
 * roles, breakdown, APY averages, the accrued total) from `getVaultV2Details`, which wins.
 */
export function toMorphoVaultV2Details(
  summary: Adapted<MorphoVaultV2Summary>,
  details: VaultV2Details,
): Adapted<Omit<MorphoVaultV2, "historical">> {
  return {
    ...summary,
    ...details,
    // Hidden until the curators AUM route is in API prod (VAU-3630), as on the earn table.
    curatorAum: undefined,
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Charts                                                                                         */
/* -------------------------------------------------------------------------------------------- */

interface VaultHistorySeries {
  totalAssets: readonly { x: number; y: BigIntish | null }[];
  totalAssetsUsd: readonly DataPoint[];
  /**
   * Net (post-fee, rewards-inclusive) APY series, keyed by the window it was requested for. A
   * protocol that serves every window natively fills all four; one that fetches only the configured
   * window fills that key alone.
   */
  netApy: Partial<Record<"6h" | "1d" | "7d" | "30d", readonly DataPoint[]>>;
}

/**
 * Morpho returns one `[{x, y}]` series per metric; the chart wants bucket rows. Only the configured
 * `apyWindow` is plotted, so exactly that series is carried through — previously one series was
 * fanned across four window-named fields, which labelled a 24h-smoothed vault V2 series as 30d and
 * quadrupled the payload. Each protocol files its series under the window it was requested for, so
 * this is a direct lookup; a window the upstream served nothing for plots as an empty series.
 *
 * A null sample stays null: the chart connects across gaps, whereas coercing to 0 would draw a
 * spurious drop to 0%.
 */
export function toVaultHistoricalEntries(series: VaultHistorySeries, decimals: number): VaultHistoricalEntry[] {
  const netApy = series.netApy[APP_CONFIG.apyWindow] ?? [];

  return zipTimeseries(
    {
      assets: descaleSeries(series.totalAssets, decimals),
      assetsUsd: series.totalAssetsUsd,
      netApy,
    },
    (bucketTimestamp, values) => ({
      bucketTimestamp,
      totalSupplied: { formatted: numberToString(values.assets ?? 0), usd: values.assetsUsd },
      netApy: { total: values.netApy },
    }),
  );
}
