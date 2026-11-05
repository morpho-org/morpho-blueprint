import { formatUnits, getAddress, type Hex } from "viem";
import { descale, toAmount, toAmountWithPrice, toBigInt } from "@/common/data/adapters/amount";
import { assembleApyWithRewards } from "@/common/data/adapters/apy";
import { toChainInfoById, toTokenInfo } from "@/common/data/adapters/entity";
import { type DataPoint, descaleSeries, zipTimeseries } from "@/common/data/adapters/timeseries";
import type { RestToken } from "@/common/data/rest/tokens";
import type { ChainInfo, CuratorInfo, RewardApy, TokenInfo } from "@/common/data/types";
import { numberToString } from "@/common/utils/format";
import { APP_CONFIG } from "@/config";
import type { MarketInfo } from "@/modules/market/market.types";
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
import type { VaultV1Details } from "./getVaultV1Details";
import type { VaultV2Details } from "./getVaultV2Details";

/**
 * The shape an adapter produces, before `normalizeVault` applies the vault config: `isHidden` is
 * not known yet and the chain id has not been narrowed to a configured chain.
 */
export type Adapted<T> = Omit<T, "isHidden" | "chain"> & { chain: ChainInfo };

function usdOf(raw: BigIntish | null | undefined, decimals: number, priceUsd: number | null): number | null {
  return priceUsd == null ? null : descale(raw, decimals) * priceUsd;
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V1 allocations                                                                           */
/* -------------------------------------------------------------------------------------------- */

/** One row of Core REST's `/v0/vaults-v1/{vault}/allocations`. */
export interface RestVaultV1Allocation {
  market_id: Hex;
  supply_assets: string;
  supply_shares: string;
  supply_cap: string;
  /** Null when the market is not in the withdraw queue (only a pending cap or removal ties it to the vault). */
  withdraw_queue_index?: number | null;
}

/**
 * The allocations in the withdraw queue, in queue order, as GraphQL listed them: REST also serves
 * markets tied to the vault only by a pending cap or removal.
 */
export function withdrawQueueAllocations<T extends RestVaultV1Allocation>(rows: readonly T[]): T[] {
  return rows
    .flatMap((row) => (row.withdraw_queue_index == null ? [] : [{ row, index: row.withdraw_queue_index }]))
    .sort((a, b) => a.index - b.index)
    .map(({ row }) => row);
}

/**
 * A vault V1's market allocations, each priced at the vault asset's price. `totalRaw` is the vault
 * total each share is taken of. A market missing from `markets` (REST could not describe it) is left
 * out.
 */
export function toRestVaultMarketAllocations(
  rows: readonly RestVaultV1Allocation[],
  markets: ReadonlyMap<string, MarketInfo>,
  decimals: number,
  priceUsd: number | null,
  totalRaw: bigint,
): VaultMarketAllocation[] {
  const total = Number(formatUnits(totalRaw, decimals));
  return rows.flatMap((row): VaultMarketAllocation[] => {
    const market = markets.get(row.market_id.toLowerCase());
    if (!market) return [];
    const supply = toAmountWithPrice(row.supply_assets, decimals, priceUsd);
    return [
      {
        // A non-zero supply cap is what makes a market enabled.
        enabled: toBigInt(row.supply_cap) > 0n,
        vaultSupplyShare: total > 0 ? Number(supply.formatted) / total : 0,
        position: { supplyAmount: supply, supplyShares: toBigInt(row.supply_shares).toString() },
        supplyCap: toAmountWithPrice(row.supply_cap, decimals, priceUsd),
        market,
      },
    ];
  });
}

/** The trimmed rows the earn-table exposure tooltip reads, from the same allocations. */
export function toRestVaultCollateralAllocations(
  rows: readonly RestVaultV1Allocation[],
  collateralByMarket: ReadonlyMap<string, TokenInfo | null>,
  decimals: number,
  priceUsd: number | null,
  totalRaw: BigIntish,
): VaultCollateralAllocation[] {
  const total = descale(totalRaw, decimals);
  return rows.flatMap((row): VaultCollateralAllocation[] => {
    const key = row.market_id.toLowerCase();
    // A market REST could not describe is left out rather than shown as idle.
    if (!collateralByMarket.has(key)) return [];
    const collateral = collateralByMarket.get(key) ?? null;
    return [
      {
        enabled: toBigInt(row.supply_cap) > 0n,
        vaultSupplyShare: total > 0 ? descale(row.supply_assets, decimals) / total : 0,
        position: { supplyAmount: { usd: usdOf(row.supply_assets, decimals, priceUsd) } },
        market: {
          collateralAsset: collateral && { icon: collateral.icon, name: collateral.name, symbol: collateral.symbol },
        },
      },
    ];
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Vault summaries (both protocols)                                                               */
/* -------------------------------------------------------------------------------------------- */

/** Core REST's reads behind one vault summary, joined by `getVaultSummaries`. */
export interface RestVaultSummarySource {
  chainId: number;
  /** `/v0/vaults-v{1,2}/{vault}`. Core REST serves the names and symbols as nullable. */
  root: {
    address: string;
    name: string | null;
    asset: { address: string; name: string | null; symbol: string | null };
  };
  /** Already checked to be a uint8. */
  decimals: number;
  /** The `state` route's total, accrued as of the last indexed block. */
  totalAssets: string;
  /** The `apy-averages` route over `APP_CONFIG.apyWindow`, net of fees, no rewards. */
  apy: number | null;
  /** Current Merkl reward APRs, one per token; empty when Merkl is down. */
  rewards: RewardApy[];
  token: RestToken | null;
  priceUsd: number | null;
  curator: CuratorInfo | null;
  description: string | null;
}

type RestVaultSummaryBase = Omit<Adapted<MorphoVaultV2Summary>, "__typename" | "allocations">;

/**
 * The fields both protocols' summaries share. `total` is the native APY plus the current Merkl
 * reward APRs. Curator AUM is set afterwards from one batched Blueprint API read for every summary
 * (`getVaultSummaries`).
 */
function toRestVaultSummaryBase(source: RestVaultSummarySource): RestVaultSummaryBase {
  const { root, token, decimals, priceUsd } = source;
  // The earn page calls string methods on these: a null would fail the whole page, not one row.
  const assetName = token?.name ?? root.asset.name;
  const assetSymbol = token?.symbol ?? root.asset.symbol ?? assetName ?? "UNKNOWN";
  return {
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
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V1                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** `marketAllocations` feeds the exposure tooltip; the vault page reads none and passes `[]`. */
export function toRestVaultV1Summary(
  source: RestVaultSummarySource,
  marketAllocations: VaultCollateralAllocation[],
): Adapted<MorphoVaultV1Summary> {
  return { __typename: "MorphoVault", ...toRestVaultSummaryBase(source), marketAllocations };
}

/**
 * The vault page's vault V1: the header fields from the REST summary, every detail field (fees,
 * roles, allocations, liquidity, APY averages) from `getVaultV1Details`, which wins.
 */
export function toMorphoVaultV1Details(
  summary: Adapted<MorphoVaultV1Summary>,
  details: VaultV1Details,
): Adapted<Omit<MorphoVaultV1, "historical">> {
  return { ...summary, ...details };
}

/* -------------------------------------------------------------------------------------------- */
/* Vault V2                                                                                       */
/* -------------------------------------------------------------------------------------------- */

/**
 * The exposure tooltip only expands MetaMorpho adapters, which REST summaries do not read, so
 * `allocations` is empty.
 */
export function toRestVaultV2Summary(source: RestVaultSummarySource): Adapted<MorphoVaultV2Summary> {
  return { __typename: "MorphoVaultV2", ...toRestVaultSummaryBase(source), allocations: [] };
}

/**
 * The vault page's vault V2: the header fields from the REST summary, every detail field (fees,
 * roles, breakdown, APY averages, the accrued total) from `getVaultV2Details`, which wins.
 */
export function toMorphoVaultV2Details(
  summary: Adapted<MorphoVaultV2Summary>,
  details: VaultV2Details,
): Adapted<Omit<MorphoVaultV2, "historical">> {
  return { ...summary, ...details };
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
