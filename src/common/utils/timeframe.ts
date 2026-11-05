import { APP_CONFIG } from "@/config";
import type { ApyWindow } from "@/config/types";

/**
 * App-owned mapping from the configured APY window onto the API's lookback vocabulary.
 * The `VaultV1LookbackPeriod` and `VaultV2LookbackPeriod` enums share these members.
 */
const APY_LOOKBACK_PERIOD = {
  "6h": "SIX_HOURS",
  "1d": "ONE_DAY",
  "7d": "SEVEN_DAYS",
  "30d": "THIRTY_DAYS",
} as const satisfies Record<ApyWindow, string>;

export type ApyLookbackPeriod = (typeof APY_LOOKBACK_PERIOD)[ApyWindow];

/** Lookback for current-state vault APYs (`avgNetApy`, `avgNetApyExcludingRewards`). */
export const apyLookbackPeriod: ApyLookbackPeriod = APY_LOOKBACK_PERIOD[APP_CONFIG.apyWindow];

/** The same window in Core REST's `apy-averages` vocabulary. */
const REST_APY_LOOKBACK = {
  "6h": "six_hours",
  "1d": "one_day",
  "7d": "seven_days",
  "30d": "thirty_days",
} as const satisfies Record<ApyWindow, string>;

export const restApyLookback = REST_APY_LOOKBACK[APP_CONFIG.apyWindow];

/**
 * Stamps the configured averaging window onto a rate label, so a quoted number is never ambiguous
 * about its timeframe — e.g. `Net APY (7d)`.
 *
 * Only for rates actually averaged over `APP_CONFIG.apyWindow`. Rates that are instantaneous by
 * construction (the IRM curve, per-token reward APRs) must not use this.
 */
export function rateLabel(base: string): string {
  return `${base} (${APP_CONFIG.apyWindow})`;
}

/**
 * The window a plotted market borrow-APY series is *actually* smoothed over. Market history serves
 * `daily`/`weekly`/`monthly` net borrow APY series only — there is no sub-daily one — so a `6h`
 * deployment plots the daily series, and naming it `6h` would claim a smoothing the points do not
 * have.
 */
export const marketHistoryApyWindow: Exclude<ApyWindow, "6h"> =
  APP_CONFIG.apyWindow === "6h" ? "1d" : APP_CONFIG.apyWindow;
