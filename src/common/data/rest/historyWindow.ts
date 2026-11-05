import { CHART_RANGES, type ChartResolution, DATA_RANGES, type DataRange } from "@/common/utils/chart-ranges";

/** The lookbacks Core's history routes accept for a chart range. */
export type HistoryLookback = "seven_days" | "thirty_days" | "ninety_days" | "inception";

// Copied from the Vaults app (`apps/vaults-app/src/lib/transforms/history/window.ts`): Core picks
// the row spacing from the lookback, hourly for `seven_days`, daily for 30 and 90 days.
const RANGE_LOOKBACK: Record<DataRange, HistoryLookback> = {
  "1W": "seven_days",
  "1M": "thirty_days",
  "3M": "ninety_days",
  All: "inception",
};

export function rangeLookback(range: DataRange): HistoryLookback {
  return RANGE_LOOKBACK[range];
}

/**
 * The lookback one fetched resolution needs: that of the widest range it serves, so every range
 * plotted from it is covered. `All` (no fixed window) wins as `inception`.
 */
export function resolutionLookback(resolution: ChartResolution): HistoryLookback {
  const ranges = DATA_RANGES.filter((range) => CHART_RANGES[range].resolution === resolution);
  const widest = ranges.reduce<DataRange | undefined>((best, range) => {
    if (!best) return range;
    const duration = (r: DataRange) => CHART_RANGES[r].durationSeconds || Number.POSITIVE_INFINITY;
    return duration(range) > duration(best) ? range : best;
  }, undefined);
  if (!widest) throw new Error(`No chart range is served by the ${resolution} resolution.`);
  return RANGE_LOOKBACK[widest];
}

// Core serves absurd APY on some first rows (1e75, -100%, -99.99%). The Vaults app plots
// its series unfiltered, so this bound is ours: outside (-99%, 1000%] a row becomes a gap.
// Core-side fix for the near -100% rows: API-5595.
export const isPlausibleApy = (apy: number | null) => apy !== null && apy > -0.99 && apy <= 10;
