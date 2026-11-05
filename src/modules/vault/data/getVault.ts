import "server-only";

import { cache } from "react";
import type { Address } from "viem";
import { HISTORY_RANGE_KEYS, type HistoryRange } from "@/common/data/adapters/timeseries";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { normalizeVault } from "@/modules/vault/utils/normalizeVault";
import type { Vault, VaultHistoricalData } from "@/modules/vault/vault.types";
import { toMorphoVaultV1Details, toMorphoVaultV2Details, toVaultHistoricalEntries } from "./adapters";
import { fetchVaultHistory, type VaultHistoryAsset } from "./getVaultHistory";
import { getVaultV1Summary, getVaultV2Summary } from "./getVaultSummaries";
import { getVaultV1Details } from "./getVaultV1Details";
import { getVaultV2Details } from "./getVaultV2Details";

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

/** The USD history prices the summary's asset; a failed summary surfaces through the summary read. */
function historyAssetOf(
  summaryRead: Promise<{ summary: { asset: VaultHistoryAsset } } | null>,
): Promise<VaultHistoryAsset | null> {
  return summaryRead.then(
    (read) => (read ? { address: read.summary.asset.address, decimals: read.summary.asset.decimals } : null),
    () => null,
  );
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
      const historyAsset = historyAssetOf(summaryRead);
      const [read, details, history] = await Promise.all([
        summaryRead,
        getVaultV1Details(chainId, vaultAddress, detailsContext, rewardIndex),
        fetchHistoryRanges((range) => fetchVaultHistory(protocol, chainId, vaultAddress, range, historyAsset)),
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
    const historyAsset = historyAssetOf(summaryRead);
    const [read, details, history] = await Promise.all([
      summaryRead,
      getVaultV2Details(chainId, vaultAddress, detailsContext, rewardIndex),
      fetchHistoryRanges((range) => fetchVaultHistory(protocol, chainId, vaultAddress, range, historyAsset)),
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
