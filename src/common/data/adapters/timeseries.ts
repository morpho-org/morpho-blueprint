import type { ChartResolution } from "@/common/utils/chart-ranges";
import type { BigIntish } from "@/morpho-types";

export interface DataPoint {
  x: number;
  y: number | null;
}

export interface BigIntDataPoint {
  x: number;
  y: BigIntish | null;
}

export type HistoryRange = ChartResolution;
export const HISTORY_RANGE_KEYS = ["hourly", "daily", "weekly"] as const satisfies readonly HistoryRange[];

type SeriesMap = Record<string, readonly DataPoint[]>;
type ZippedValues<S extends SeriesMap> = { [K in keyof S]: number | null };

/**
 * Morpho returns one `[{x, y}]` series per metric; Whisk returned bucket rows with every metric
 * inline. This joins the series back into rows keyed on `x`.
 *
 * Series are not guaranteed to share timestamps (a metric can carry an extra "now" point, or start
 * later), and come back newest-first. Rows are emitted oldest-first over the union of timestamps,
 * carrying each series' last known value forward; leading rows where a series has no value yet are
 * dropped so no row is invented from nothing.
 */
export function zipTimeseries<S extends SeriesMap, T>(
  series: S,
  buildEntry: (bucketTimestamp: number, values: ZippedValues<S>) => T,
): T[] {
  const keys = Object.keys(series) as (keyof S)[];
  if (keys.length === 0) return [];

  const timestamps = new Set<number>();
  const byTimestamp = new Map<keyof S, Map<number, number | null>>();

  for (const key of keys) {
    const points = new Map<number, number | null>();
    for (const point of series[key] ?? []) {
      timestamps.add(point.x);
      points.set(point.x, point.y);
    }
    byTimestamp.set(key, points);
  }

  // A series the upstream returns entirely empty must not gate emission. Its key would never enter
  // `lastKnown`, so the leading-row trim below would fire on every timestamp and this would return
  // `[]` — no chart at all, rather than a chart missing one metric. Only series that actually carry
  // points participate in the trim; an empty one contributes `null` to every row, which the chart
  // renders as a gap. This is reachable: an idle market serves no `collateralAssetsUsd`, and a vault
  // younger than the window serves no `monthlyNetApy`.
  const gatingKeys = keys.filter((key) => (byTimestamp.get(key)?.size ?? 0) > 0);
  if (gatingKeys.length === 0) return [];

  const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b);
  const lastKnown = new Map<keyof S, number | null>();
  const entries: T[] = [];

  for (const timestamp of sortedTimestamps) {
    for (const key of keys) {
      const value = byTimestamp.get(key)?.get(timestamp);
      if (value !== undefined) lastKnown.set(key, value);
    }

    // Skip leading rows: a series that has points has not reached its first one yet.
    if (gatingKeys.some((key) => !lastKnown.has(key))) continue;

    const values = {} as ZippedValues<S>;
    for (const key of keys) {
      values[key] = lastKnown.get(key) ?? null;
    }
    entries.push(buildEntry(timestamp, values));
  }

  return entries;
}

/** `BigIntDataPoint` series carry BigInt strings; descale them to plain numbers up front. */
export function descaleSeries(points: readonly BigIntDataPoint[], decimals: number): DataPoint[] {
  const scale = 10 ** Math.round(decimals);
  return points.map(({ x, y }) => ({ x, y: y == null ? null : Number(y) / scale }));
}
