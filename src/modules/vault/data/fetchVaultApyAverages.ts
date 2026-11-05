import "server-only";

import type { ApyAverages } from "@/common/data/types";
import { fetchMorphoRestResource } from "@/common/utils/fetchMorphoRest";

const APY_AVERAGE_LOOKBACKS = {
  sevenDays: "seven_days",
  thirtyDays: "thirty_days",
  ninetyDays: "ninety_days",
  inception: "inception",
} as const satisfies Record<keyof ApyAverages, string>;

/**
 * One realized net APY per chart range from a vault's Core REST `apy-averages` route (`path`); null
 * when REST has none (a vault younger than the window).
 */
export async function fetchVaultApyAverages(path: string): Promise<ApyAverages> {
  const entries = await Promise.all(
    Object.entries(APY_AVERAGE_LOOKBACKS).map(async ([key, lookback]) => {
      const response = await fetchMorphoRestResource<{ data: { apy: number | null } }>(path, { lookback });
      return [key, response?.data.apy ?? null] as const;
    }),
  );
  const byKey = Object.fromEntries(entries);
  return {
    sevenDays: byKey.sevenDays ?? null,
    thirtyDays: byKey.thirtyDays ?? null,
    ninetyDays: byKey.ninetyDays ?? null,
    inception: byKey.inception ?? null,
  };
}
