import "server-only";

import type { Address } from "viem";
import type { DataPoint } from "@/common/data/adapters/timeseries";
import type { HistoryLookback } from "@/common/data/rest/historyWindow";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";

interface RestPriceHistory {
  data: { points: { timestamp: number; price_usd: number | null }[] };
}

// Core spaces `seven_days` rows hourly and the longer lookbacks daily; prices are sampled to match.
const PRICE_INTERVAL: Record<HistoryLookback, { interval: "hour" | "day"; seconds: number }> = {
  seven_days: { interval: "hour", seconds: 3600 },
  thirty_days: { interval: "day", seconds: 86_400 },
  ninety_days: { interval: "day", seconds: 86_400 },
  inception: { interval: "day", seconds: 86_400 },
};

/**
 * A raw token amount series priced in USD from the Blueprint API's token price history. Empty when
 * that API is off or the read fails, which hides the chart's USD toggle; Core REST serves no USD
 * history.
 */
export async function fetchUsdSeries(
  chainId: number,
  lookback: HistoryLookback,
  amounts: readonly { x: number; y: string | null }[],
  asset: { address: Address; decimals: number } | null,
): Promise<DataPoint[]> {
  const first = amounts[0];
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
  return amounts.map(({ x, y }) => {
    // Both series are oldest-first: advance to the price sample nearest this state row.
    const distance = (index: number) => Math.abs((points[index]?.timestamp ?? Number.POSITIVE_INFINITY) - x);
    while (cursor + 1 < points.length && distance(cursor + 1) <= distance(cursor)) cursor += 1;
    const sample = points[cursor];
    const price = sample && distance(cursor) <= seconds ? sample.price_usd : null;
    return { x, y: price === null || y === null ? null : (Number(y) / scale) * price };
  });
}
