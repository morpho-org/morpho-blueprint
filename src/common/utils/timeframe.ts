import { APP_CONFIG } from "@/config";
import type { ApyWindow } from "@/config/types";

/** The configured APY window in Core REST's `apy-averages` vocabulary. */
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
