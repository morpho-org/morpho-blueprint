import "server-only";

import { cache } from "react";
import type { Address } from "viem";
import { HISTORY_RANGE_KEYS, type HistoryRange } from "@/common/data/adapters/timeseries";
import { isPlausibleApy, resolutionLookback } from "@/common/data/rest/historyWindow";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { normalizeVault } from "@/modules/vault/utils/normalizeVault";
import type { Vault, VaultHistoricalData } from "@/modules/vault/vault.types";
import { toMorphoVaultV1Details, toMorphoVaultV2Details, toVaultHistoricalEntries } from "./adapters";
import { getVaultV1Summary, getVaultV2Summary } from "./getVaultSummaries";
import { getVaultV1Details } from "./getVaultV1Details";
import { getVaultV2Details } from "./getVaultV2Details";
import { fetchVaultV2History } from "./getVaultV2History";

export type { Vault };

/**
 * Fetches the three chart resolutions in parallel, one REST lookback each (see `resolutionLookback`).
 * Keyed by range rather than positional, so `HISTORY_RANGE_KEYS`' order is not load-bearing.
 */
async function fetchHistoryRanges<T>(
  fetchRange: (range: HistoryRange) => Promise<T | null>,
): Promise<Record<HistoryRange, T | null>> {
  const entries = await Promise.all(HISTORY_RANGE_KEYS.map(async (range) => [range, await fetchRange(range)] as const));
  return Object.fromEntries(entries) as Record<HistoryRange, T | null>;
}

export const getVault = cache(
  async (chainId: SupportedChainId, vaultAddress: Address, protocol: Erc4626VaultProtocol): Promise<Vault> => {
    // One Merkl read for the page, shared by the header APY and the breakdown rows.
    const rewardIndex = getMerklRewardIndex(chainId);

    if (protocol === Erc4626VaultProtocol.MorphoV1) {
      const summaryRead = getVaultV1Summary(chainId, vaultAddress, rewardIndex);
      // The details reuse the summary's root, state, asset decimals and price; a failed summary
      // resolves to no context here and surfaces through `summaryRead`.
      const detailsContext = summaryRead.then(
        (read) =>
          read && {
            chain: read.summary.chain,
            asset: {
              address: read.summary.asset.address,
              decimals: read.summary.asset.decimals,
              priceUsd: read.summary.asset.priceUsd,
            },
            root: read.root,
            state: read.state,
          },
        () => null,
      );
      const [read, details, history] = await Promise.all([
        summaryRead,
        getVaultV1Details(chainId, vaultAddress, detailsContext, rewardIndex),
        fetchHistoryRanges((range) => fetchVaultV1History(chainId, vaultAddress, range)),
      ]);
      if (!read || !details) throw new Error(`Vault not found: ${chainId}:${vaultAddress}`);

      const decimals = read.summary.asset.decimals;
      const historical: VaultHistoricalData = buildHistoricalData(history, (series) =>
        toVaultHistoricalEntries(series, decimals),
      );

      return normalizeVault({ ...toMorphoVaultV1Details(read.summary, details), historical });
    }

    const summaryRead = getVaultV2Summary(chainId, vaultAddress, rewardIndex);
    // The details reuse the summary's root, state, asset decimals and price instead of reading them
    // again; their other reads start right away. A failed summary resolves to no context here: its
    // error surfaces through `summaryRead`.
    const detailsContext = summaryRead.then(
      (read) =>
        read && {
          chain: read.summary.chain,
          asset: {
            address: read.summary.asset.address,
            decimals: read.summary.asset.decimals,
            priceUsd: read.summary.asset.priceUsd,
          },
          root: read.root,
          state: read.state,
        },
      () => null,
    );
    // The USD history prices the summary's asset; a failed summary surfaces through `summaryRead`.
    const historyAsset = summaryRead.then(
      (read) => (read ? { address: read.summary.asset.address, decimals: read.summary.asset.decimals } : null),
      () => null,
    );
    const [read, details, history] = await Promise.all([
      summaryRead,
      getVaultV2Details(chainId, vaultAddress, detailsContext, rewardIndex),
      fetchHistoryRanges((range) => fetchVaultV2History(chainId, vaultAddress, range, historyAsset)),
    ]);

    if (!read || !details) throw new Error(`Vault not found: ${chainId}:${vaultAddress}`);
    const vault = read.summary;

    const decimals = vault.asset.decimals;
    const historical: VaultHistoricalData = buildHistoricalData(history, (series) =>
      toVaultHistoricalEntries(series, decimals),
    );

    return normalizeVault({ ...toMorphoVaultV2Details(vault, details), historical });
  },
);

interface RestHistory<T> {
  data: ({ timestamp: number } & T)[];
}

/**
 * Vault V1 chart series for one resolution, from Core REST. REST serves no USD total-assets history,
 * and one net APY series whose averaging window follows the lookback; it fills the configured
 * window's key, as the V2 path does.
 */
async function fetchVaultV1History(chainId: SupportedChainId, vaultAddress: Address, range: HistoryRange) {
  const selector = restSelector(chainId, vaultAddress);
  // One lookback per resolution, from the Vaults app range table: 1W hourly, 3M daily, All monthly.
  const query = { lookback: resolutionLookback(range) };
  const [state, apy] = await Promise.all([
    fetchMorphoRestResource<RestHistory<{ total_assets: string }>>(`/v0/vaults-v1/${selector}/state/history`, query),
    fetchMorphoRestResource<RestHistory<{ apy: number | null }>>(`/v0/vaults-v1/${selector}/apy/history`, query),
  ]);
  if (!state || !apy) return null;

  return {
    totalAssets: state.data.map((point) => ({ x: point.timestamp, y: point.total_assets })),
    totalAssetsUsd: [],
    netApy: {
      [APP_CONFIG.apyWindow]: apy.data.map((point) => ({
        x: point.timestamp,
        y: isPlausibleApy(point.apy) ? point.apy : null,
      })),
    },
  };
}

/** Maps each fetched resolution onto its chart series; a range the API served nothing for is empty. */
function buildHistoricalData<T>(
  byRange: Record<HistoryRange, T | null>,
  toEntries: (series: T) => ReturnType<typeof toVaultHistoricalEntries>,
): VaultHistoricalData {
  const entriesFor = (range: HistoryRange) => {
    const series = byRange[range];
    return series ? toEntries(series) : [];
  };
  return { hourly: entriesFor("hourly"), daily: entriesFor("daily"), weekly: entriesFor("weekly") };
}
