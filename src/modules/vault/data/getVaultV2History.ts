import "server-only";

import type { Address } from "viem";
import { isPlausibleApy, resolutionLookback } from "@/common/data/rest/historyWindow";
import { fetchUsdSeries } from "@/common/data/rest/priceHistory";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import type { toVaultHistoricalEntries } from "./adapters";

type VaultHistorySeries = Parameters<typeof toVaultHistoricalEntries>[0];

interface RestHistory<T> {
  data: ({ timestamp: number } & T)[];
}

export interface VaultHistoryAsset {
  address: Address;
  decimals: number;
}

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
    totalAssetsUsd: await fetchUsdSeries(chainId, lookback, totalAssets, await asset),
    netApy: { [APP_CONFIG.apyWindow]: netApy },
  };
}
