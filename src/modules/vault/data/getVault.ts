import "server-only";

import { cache } from "react";
import type { Address } from "viem";
import { HISTORY_RANGE_KEYS, type HistoryRange, historyOptions } from "@/common/data/adapters/timeseries";
import { resolutionLookback } from "@/common/data/rest/historyWindow";
import { executeMorphoQuery } from "@/common/utils/executeMorphoQuery";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { apyLookbackPeriod, vaultV2HistoryLookbackHours } from "@/common/utils/timeframe";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { graphql } from "@/generated/gql/morpho";
import { normalizeVault } from "@/modules/vault/utils/normalizeVault";
import type { Vault, VaultHistoricalData } from "@/modules/vault/vault.types";
import { toMorphoVaultV1Details, toMorphoVaultV2Details, toVaultHistoricalEntries } from "./adapters";
import { ADAPTERS_PAGE_SIZE, CAPS_PAGE_SIZE, POSITIONS_PAGE_SIZE } from "./pagination";

const vaultV2Query = graphql(`
  query VaultV2(
    $chainId: Int!
    $address: String!
    $lookbackV1: VaultV1LookbackPeriod!
    $lookbackV2: VaultV2LookbackPeriod!
    $capsFirst: Int!
    $adaptersFirst: Int!
    $positionsFirst: Int!
  ) {
    vaultV2s(first: 1, where: { chainId_in: [$chainId], address_in: [$address] }) {
      items {
        ...MorphoVaultV2SummaryFragment
        ...MorphoVaultV2DetailsFragment
      }
    }
  }
`);

const vaultV2HistoryQuery = graphql(`
  query VaultV2History($chainId: Int!, $address: String!, $lookbackHours: Int!, $options: TimeseriesOptions!) {
    vaultV2s(first: 1, where: { chainId_in: [$chainId], address_in: [$address] }) {
      items {
        historicalState {
          ...MorphoVaultV2HistoryFragment
        }
      }
    }
  }
`);

const vaultV1Query = graphql(`
  query VaultV1($chainId: Int!, $address: String!, $lookbackV1: VaultV1LookbackPeriod!) {
    vaults(first: 1, where: { chainId_in: [$chainId], address_in: [$address] }) {
      items {
        ...MorphoVaultV1SummaryFragment
        ...MorphoVaultV1DetailsFragment
      }
    }
  }
`);

export type { Vault };

/**
 * Fetches the three chart resolutions in parallel; each is its own request (see `historyOptions`).
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
    if (protocol === Erc4626VaultProtocol.MorphoV1) {
      const [data, history] = await Promise.all([
        executeMorphoQuery(vaultV1Query, { chainId, address: vaultAddress, lookbackV1: apyLookbackPeriod }),
        fetchHistoryRanges((range) => fetchVaultV1History(chainId, vaultAddress, range)),
      ]);

      const vault = data.vaults.items?.[0];
      if (!vault) throw new Error(`Vault not found: ${chainId}:${vaultAddress}`);

      const decimals = Math.round(vault.asset.decimals);
      const historical: VaultHistoricalData = buildHistoricalData(history, (series) =>
        toVaultHistoricalEntries(series, decimals),
      );

      return normalizeVault({ ...toMorphoVaultV1Details(vault), historical });
    }

    const [data, history] = await Promise.all([
      executeMorphoQuery(vaultV2Query, {
        chainId,
        address: vaultAddress,
        lookbackV1: apyLookbackPeriod,
        lookbackV2: apyLookbackPeriod,
        capsFirst: CAPS_PAGE_SIZE,
        adaptersFirst: ADAPTERS_PAGE_SIZE,
        positionsFirst: POSITIONS_PAGE_SIZE,
      }),
      fetchHistoryRanges(async (range) => {
        const response = await executeMorphoQuery(vaultV2HistoryQuery, {
          chainId,
          address: vaultAddress,
          lookbackHours: vaultV2HistoryLookbackHours,
          options: historyOptions(range),
        });
        return response.vaultV2s.items?.[0]?.historicalState ?? null;
      }),
    ]);

    const vault = data.vaultV2s.items?.[0];
    if (!vault) throw new Error(`Vault not found: ${chainId}:${vaultAddress}`);

    const decimals = Math.round(vault.asset.decimals);
    // Only the configured window is fetched, so it is filed under exactly that key — note the
    // series is smoothed over at most 24h whatever the window (see `vaultV2HistoryLookbackHours`).
    const historical: VaultHistoricalData = buildHistoricalData(history, (series) =>
      toVaultHistoricalEntries(
        {
          totalAssets: series.totalAssets,
          totalAssetsUsd: series.totalAssetsUsd,
          netApy: { [APP_CONFIG.apyWindow]: series.avgNetApy },
        },
        decimals,
      ),
    );

    return normalizeVault({ ...toMorphoVaultV2Details(vault), historical });
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
    netApy: { [APP_CONFIG.apyWindow]: apy.data.map((point) => ({ x: point.timestamp, y: point.apy })) },
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
