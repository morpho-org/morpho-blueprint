import "server-only";

import type { Address } from "viem";
import type { DataPoint } from "@/common/data/adapters/timeseries";
import { type HistoryLookback, resolutionLookback } from "@/common/data/rest/historyWindow";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import type { toVaultHistoricalEntries } from "./adapters";

type VaultHistorySeries = Parameters<typeof toVaultHistoricalEntries>[0];

interface RestHistory<T> {
  data: ({ timestamp: number } & T)[];
}

interface RestPriceHistory {
  data: { points: { timestamp: number; price_usd: number | null }[] };
}

export interface VaultHistoryAsset {
  address: Address;
  decimals: number;
}

// Core spaces `seven_days` rows hourly and the longer lookbacks daily; prices are sampled to match.
const PRICE_INTERVAL: Record<HistoryLookback, { interval: "hour" | "day"; seconds: number }> = {
  seven_days: { interval: "hour", seconds: 3600 },
  thirty_days: { interval: "day", seconds: 86_400 },
  ninety_days: { interval: "day", seconds: 86_400 },
  inception: { interval: "day", seconds: 86_400 },
};

// Core serves absurd APY on some vaults' first rows (1e75, -100%). The Vaults app plots its series
// unfiltered, so this bound is ours: outside (-100%, 1000%] a row becomes a gap.
const isPlausibleApy = (apy: number | null) => apy !== null && apy > -1 && apy <= 10;

/**
 * Vault V2 chart series for one resolution, from Core REST: total assets from `state/history` and
 * the net APY from `apy/history` (out-of-range rows as gaps), filed under the configured window's
 * key as V1 does.
 * `null` when Core reports the vault missing.
 */
export async function fetchVaultV2History(
  chainId: SupportedChainId,
  vaultAddress: Address,
  resolution: Parameters<typeof resolutionLookback>[0],
  asset: Promise<VaultHistoryAsset | null>,
): Promise<VaultHistorySeries | null> {
  const selector = restSelector(chainId, vaultAddress);
  const lookback = resolutionLookback(resolution);
  const query = { lookback };
  const [state, apy] = await Promise.all([
    fetchMorphoRestResource<RestHistory<{ total_assets: string }>>(`/v0/vaults-v2/${selector}/state/history`, query),
    fetchMorphoRestResource<RestHistory<{ apy: number | null }>>(`/v0/vaults-v2/${selector}/apy/history`, query),
  ]);
  if (!state || !apy) return null;

  const totalAssets = state.data.map((point) => ({ x: point.timestamp, y: point.total_assets }));
  // Core serves no APY for a vault's first day. Null APY on the state rows before the first sample
  // keeps those rows: the zip drops leading rows until every non-empty series has a value.
  const firstApyAt = apy.data[0]?.timestamp ?? Number.POSITIVE_INFINITY;
  const netApy = [
    ...totalAssets.filter((point) => point.x < firstApyAt).map((point) => ({ x: point.x, y: null })),
    ...apy.data.map((point) => ({ x: point.timestamp, y: isPlausibleApy(point.apy) ? point.apy : null })),
  ];
  return {
    totalAssets,
    totalAssetsUsd: await fetchTotalAssetsUsd(chainId, lookback, totalAssets, await asset),
    netApy: { [APP_CONFIG.apyWindow]: netApy },
  };
}

/**
 * USD total assets from the Blueprint API's token price history. Empty when that API is off or the
 * read fails, which hides the chart's USD toggle; Core REST serves no USD history.
 */
async function fetchTotalAssetsUsd(
  chainId: SupportedChainId,
  lookback: HistoryLookback,
  totalAssets: { x: number; y: string }[],
  asset: VaultHistoryAsset | null,
): Promise<DataPoint[]> {
  const first = totalAssets[0];
  if (!asset || !first || !isBlueprintApiEnabled()) return [];

  const { interval, seconds } = PRICE_INTERVAL[lookback];
  const prices = await fetchMorphoRestResource<RestPriceHistory>(
    `/v0/blueprint-app-api/token-prices/${restSelector(chainId, asset.address)}/history`,
    // No end: the route then defaults to its own now and adds a request-time price, which prices
    // Core's request-time state row. An app-clock end can fall a second short and drop it.
    { start_timestamp: first.x, interval },
    { api: "blueprint", quiet: true },
  ).catch(() => null);
  if (!prices) return [];

  const points = prices.data.points;
  const scale = 10 ** asset.decimals;
  let cursor = 0;
  return totalAssets.map(({ x, y }) => {
    // Both series are oldest-first: advance to the price sample nearest this state row.
    const distance = (index: number) => Math.abs((points[index]?.timestamp ?? Number.POSITIVE_INFINITY) - x);
    while (cursor + 1 < points.length && distance(cursor + 1) <= distance(cursor)) cursor += 1;
    const sample = points[cursor];
    const price = sample && distance(cursor) <= seconds ? sample.price_usd : null;
    return { x, y: price === null ? null : (Number(y) / scale) * price };
  });
}
