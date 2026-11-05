import "server-only";

import type { Address, Hex } from "viem";
import { HISTORY_RANGE_KEYS } from "@/common/data/adapters/timeseries";
import { isPlausibleApy, resolutionLookback } from "@/common/data/rest/historyWindow";
import { fetchUsdSeries } from "@/common/data/rest/priceHistory";
import type { ChartResolution } from "@/common/utils/chart-ranges";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { marketHistoryApyWindow } from "@/common/utils/timeframe";
import type { SupportedChainId } from "@/config/types";
import type { Market, MarketHistoricalEntry } from "@/modules/market/market.types";
import { toMarketHistoricalEntries } from "./adapters";

interface RestHistory<T> {
  data: ({ timestamp: number } & T)[];
}

interface RestMarketStateRow {
  total_supply_assets: string;
  total_borrow_assets: string;
  total_collateral_assets: string | null;
}

interface HistoryToken {
  address: Address;
  decimals: number;
}

type Series = Parameters<typeof toMarketHistoricalEntries>[0];

/**
 * One chart resolution from Core REST: totals from `state/history`, the native borrow APY from
 * `apy/history` (out-of-range rows as gaps), and USD totals from the Blueprint price history when
 * its key is set. `null` when Core reports history unavailable for the market or chain.
 */
async function fetchMarketHistory(
  chainId: SupportedChainId,
  marketId: Hex,
  resolution: ChartResolution,
  loan: HistoryToken,
  collateral: HistoryToken | null,
): Promise<MarketHistoricalEntry[] | null> {
  const selector = restSelector(chainId, marketId);
  const lookback = resolutionLookback(resolution);
  const query = { lookback };
  const [state, apy] = await Promise.all([
    fetchMorphoRestResource<RestHistory<RestMarketStateRow>>(`/v0/blue/markets/${selector}/state/history`, query),
    fetchMorphoRestResource<RestHistory<{ borrow_apy: number | null }>>(
      `/v0/blue/markets/${selector}/apy/history`,
      query,
    ),
  ]);
  if (!state || !apy) return null;

  const supply = state.data.map((row) => ({ x: row.timestamp, y: row.total_supply_assets }));
  const borrow = state.data.map((row) => ({ x: row.timestamp, y: row.total_borrow_assets }));
  const collateralAssets = state.data.map((row) => ({ x: row.timestamp, y: row.total_collateral_assets }));
  // State rows before the first APY sample keep a null APY, or the zip would trim them.
  const firstApyAt = apy.data[0]?.timestamp ?? Number.POSITIVE_INFINITY;
  const borrowApy = [
    ...supply.filter((point) => point.x < firstApyAt).map((point) => ({ x: point.x, y: null })),
    ...apy.data.map((row) => ({ x: row.timestamp, y: isPlausibleApy(row.borrow_apy) ? row.borrow_apy : null })),
  ];

  const [supplyUsd, borrowUsd, collateralUsd] = await Promise.all([
    fetchUsdSeries(chainId, lookback, supply, loan),
    fetchUsdSeries(chainId, lookback, borrow, loan),
    fetchUsdSeries(chainId, lookback, collateralAssets, collateral),
  ]);

  // Core serves one native borrow APY per point, smoothed over a window set by the lookback, and
  // no rewards history: it is filed under the window the chart reads, as base and total.
  const apySeries: Pick<Series, `${"borrowApy" | "netBorrowApy"}${"1d" | "7d" | "30d"}`> = {
    borrowApy1d: [],
    netBorrowApy1d: [],
    borrowApy7d: [],
    netBorrowApy7d: [],
    borrowApy30d: [],
    netBorrowApy30d: [],
    [`borrowApy${marketHistoryApyWindow}`]: borrowApy,
    [`netBorrowApy${marketHistoryApyWindow}`]: borrowApy,
  };

  return toMarketHistoricalEntries(
    {
      supplyAssets: supply,
      supplyAssetsUsd: supplyUsd,
      borrowAssets: borrow,
      borrowAssetsUsd: borrowUsd,
      collateralAssets,
      collateralAssetsUsd: collateralUsd,
      ...apySeries,
    },
    loan.decimals,
    collateral?.decimals ?? 0,
  );
}

/** The market charts' three resolutions. `null` when Core serves no history for the market. */
export async function getMarketHistory(
  chainId: SupportedChainId,
  marketId: Hex,
  loan: HistoryToken,
  collateral: HistoryToken | null,
): Promise<Market["historical"]> {
  const [hourly, daily, weekly] = await Promise.all(
    HISTORY_RANGE_KEYS.map((resolution) => fetchMarketHistory(chainId, marketId, resolution, loan, collateral)),
  );
  if (!hourly || !daily || !weekly) return null;
  return { hourly, daily, weekly };
}
