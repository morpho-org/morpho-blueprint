import "server-only";

import { cache } from "react";
import { type Address, getAddress } from "viem";
import { pageSize, warnIfTruncated } from "@/common/data/adapters/pagination";
import { getCuratorInfo } from "@/common/data/rest/curators";
import { getTokenMetadata, getTokenPriceUsd, getVaultAssetDecimals } from "@/common/data/rest/tokens";
import type { CuratorInfo } from "@/common/data/types";
import { executeMorphoQuery } from "@/common/utils/executeMorphoQuery";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";
import { apyLookbackPeriod, restApyLookback } from "@/common/utils/timeframe";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { graphql } from "@/generated/gql/morpho";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { emptyMerklRewardIndex, type MerklRewardIndex, vaultRewardApys } from "@/modules/reward/data/merklRewardApys";
import { withRewardTokenMetadata } from "@/modules/reward/data/rewardTokenMetadata";
import { normalizeVault } from "@/modules/vault/utils/normalizeVault";
import type { MorphoVaultV2Summary, VaultSummary } from "@/modules/vault/vault.types";
import { type Adapted, toMorphoVaultV1Summary, toRestVaultV2Summary } from "./adapters";

// Vault V2 summaries come from Core REST, one set of reads per vault. Vault V1 summaries still
// come from GraphQL, one request per chain (VAU-3620 moves them to REST).
//
// `first` is passed as a variable sized to the number of addresses requested, not a fixed page
// size: the API multiplies a paginated field's cost by `first`, so an oversized page blows the
// query-complexity cap even when only a handful of vaults match.
const vaultV1SummariesQuery = graphql(`
  query VaultV1Summaries($first: Int!, $chainIds: [Int!]!, $addresses: [String!]!, $lookbackV1: VaultV1LookbackPeriod!) {
    vaults(first: $first, where: { chainId_in: $chainIds, address_in: $addresses }) {
      pageInfo {
        count
        countTotal
      }
      items {
        ...MorphoVaultV1SummaryFragment
        ...MorphoVaultV1CollateralFragment
      }
    }
  }
`);

function vaultKey(chainId: number, address: string) {
  return `${chainId}:${getAddress(address)}`;
}

interface RestVaultV2Root {
  data: {
    address: string;
    name: string | null;
    asset: { address: string; decimals: unknown; name: string | null; symbol: string | null };
    curator: string | null;
    performance_fee_wad: string | null;
    management_fee_wad: string | null;
  };
}

interface RestVaultV2State {
  data: { total_assets: string; idle_assets: string };
}

interface RestVaultMetadata {
  chain_id: number;
  vault_address: string;
  description: string | null;
}

/**
 * One vault V2's summary with the root and state it was built from, which the vault page's details
 * reuse rather than read again.
 */
export interface VaultV2SummaryRead {
  summary: Adapted<MorphoVaultV2Summary>;
  root: RestVaultV2Root["data"];
  state: RestVaultV2State["data"];
}

/** One read per unique key, shared by every vault that needs it (vaults share assets and curators). */
function once<R>(load: (chainId: number, address: Address) => Promise<R>) {
  const pending = new Map<string, Promise<R>>();
  return (chainId: number, address: Address) => {
    const key = vaultKey(chainId, address);
    const existing = pending.get(key);
    if (existing) return existing;
    const started = load(chainId, address);
    pending.set(key, started);
    return started;
  };
}

/**
 * Curated descriptions from the Blueprint API, when its key is set. A failed read is logged as a
 * warning and the vaults fall back to their config description, as with the key unset.
 */
async function getVaultV2Descriptions(vaults: readonly { chainId: number; address: string }[]) {
  const descriptions = new Map<string, string | null>();
  if (!isBlueprintApiEnabled() || vaults.length === 0) return descriptions;
  const { data } = await tryCatch(
    Promise.all(
      chunk(vaults.map((vault) => restSelector(vault.chainId, vault.address))).map((selectors) =>
        fetchAllMorphoRestPages<RestVaultMetadata>(
          "/v0/blueprint-app-api/vaults-v2/metadata",
          { vaults: selectors },
          { api: "blueprint", quiet: true },
        ),
      ),
    ),
  );
  for (const row of data?.flat() ?? []) descriptions.set(vaultKey(row.chain_id, row.vault_address), row.description);
  return descriptions;
}

/**
 * The adapted (not yet normalized) vault V2 summaries, in input order, without the vaults REST does
 * not know. `rewardIndexes` lets a caller share its Merkl reads; a chain missing from it is read here.
 * Every vault is read at once: the REST client caps the calls in flight.
 */
async function getVaultV2Summaries(
  vaults: readonly { chainId: number; address: string }[],
  rewardIndexes = new Map<number, Promise<MerklRewardIndex>>(),
): Promise<VaultV2SummaryRead[]> {
  const tokenOf = once(getTokenMetadata);
  const priceOf = once(getTokenPriceUsd);
  const curatorOf = once(getCuratorInfo);
  // One Merkl read per chain, shared by every vault on it: React `cache` does not dedupe outside a
  // render (the health-check route), so the call site does.
  for (const { chainId } of vaults) {
    if (!rewardIndexes.has(chainId)) rewardIndexes.set(chainId, getMerklRewardIndex(chainId));
  }

  const readVault = async ({ chainId, address }: { chainId: number; address: string }) => {
    const selector = restSelector(chainId, address);
    const [root, state, apy, rewardIndex] = await Promise.all([
      fetchMorphoRestResource<RestVaultV2Root>(`/v0/vaults-v2/${selector}`),
      fetchMorphoRestResource<RestVaultV2State>(`/v1/vaults-v2/${selector}/state`),
      fetchMorphoRestResource<{ data: { apy: number | null } }>(`/v1/vaults-v2/${selector}/apy-averages`, {
        lookback: restApyLookback,
      }),
      rewardIndexes.get(chainId) ?? emptyMerklRewardIndex(),
    ]);
    if (!root || !state) return null;

    const asset = getAddress(root.data.asset.address);
    const [token, priceUsd, curator] = await Promise.all([
      tokenOf(chainId, asset),
      priceOf(chainId, asset),
      root.data.curator ? curatorOf(chainId, getAddress(root.data.curator)) : Promise.resolve<CuratorInfo | null>(null),
    ]);
    const decimals = await getVaultAssetDecimals(chainId, root.data.asset, token);
    // A vault with unknown decimals is dropped below: no reward metadata read for it.
    const rewardApys = decimals === null ? [] : vaultRewardApys(rewardIndex, getAddress(root.data.address), "v2");
    const rewards = await withRewardTokenMetadata(rewardIndex, rewardApys);
    return {
      chainId,
      root: root.data,
      state: state.data,
      totalAssets: state.data.total_assets,
      apy: apy?.data.apy ?? null,
      rewards,
      token,
      priceUsd,
      curator,
      decimals,
    };
  };

  const [descriptions, reads] = await Promise.all([getVaultV2Descriptions(vaults), Promise.all(vaults.map(readVault))]);

  return reads.flatMap((read): VaultV2SummaryRead[] => {
    if (!read) return [];
    const { decimals, state, ...source } = read;
    // Formatting with a guessed scale would misstate every amount by orders of magnitude.
    if (decimals === null) {
      console.warn(`Vault asset decimals unknown: ${read.chainId}:${read.root.address}`);
      return [];
    }
    const description = descriptions.get(vaultKey(read.chainId, read.root.address)) ?? null;
    return [{ summary: toRestVaultV2Summary({ ...source, decimals, description }), root: read.root, state }];
  });
}

/**
 * One vault V2's summary (the vault page header), from the same reads as the earn table, with the
 * root and state behind it. `null` when REST does not know the vault. The caller passes its Merkl
 * read so the page makes one.
 */
export async function getVaultV2Summary(
  chainId: number,
  address: Address,
  rewardIndex: Promise<MerklRewardIndex>,
): Promise<VaultV2SummaryRead | null> {
  const [summary] = await getVaultV2Summaries([{ chainId, address }], new Map([[chainId, rewardIndex]]));
  return summary ?? null;
}

export type { VaultSummary };

export const getVaultSummaries = cache(async (): Promise<VaultSummary[]> => {
  const configuredVaults = Object.entries(APP_CONFIG.supportedVaults).flatMap(([chainId, vaults]) =>
    vaults.map((vault) => ({ chainId: Number.parseInt(chainId) as SupportedChainId, ...vault })),
  );

  // Vault V1: one request per chain, rather than one `chainId_in` x `address_in` request across
  // all of them. Those two filters are independent, so a combined request matches their Cartesian
  // product: an address that also resolves on another configured chain comes back as an extra item,
  // consumes a slot in a page sized to the configured address count, and pushes a genuinely
  // configured vault out of the response, where it would surface only as the "not returned by the
  // API" warning below.
  const v1ByChain = new Map<SupportedChainId, string[]>();
  for (const vault of configuredVaults) {
    if (vault.protocol === Erc4626VaultProtocol.MorphoV2) continue;
    v1ByChain.set(vault.chainId, [...(v1ByChain.get(vault.chainId) ?? []), vault.address]);
  }

  const [v2Summaries, v1Responses] = await Promise.all([
    getVaultV2Summaries(configuredVaults.filter((vault) => vault.protocol === Erc4626VaultProtocol.MorphoV2)),
    Promise.all(
      Array.from(v1ByChain.entries()).map(([chainId, v1]) =>
        executeMorphoQuery(vaultV1SummariesQuery, {
          first: pageSize(v1.length, "vault V1s"),
          chainIds: [chainId],
          addresses: v1,
          lookbackV1: apyLookbackPeriod,
        }),
      ),
    ),
  ]);

  const byKey = new Map<string, VaultSummary>();

  for (const { summary } of v2Summaries) {
    byKey.set(vaultKey(summary.chain.id, summary.vaultAddress), normalizeVault(summary));
  }
  for (const response of v1Responses) {
    warnIfTruncated("vault V1s", response.vaults.pageInfo);
    for (const vault of response.vaults.items ?? []) {
      byKey.set(vaultKey(vault.chain.id, vault.address), normalizeVault(toMorphoVaultV1Summary(vault)));
    }
  }

  // Iterate the config rather than the responses so the order is deterministic and a vault the API
  // does not know about is reported rather than silently dropped.
  return configuredVaults.flatMap((configured) => {
    const vault = byKey.get(vaultKey(configured.chainId, configured.address));
    if (!vault) {
      console.warn(`Vault not returned by the API: ${configured.chainId}:${configured.address}`);
      return [];
    }
    return [vault];
  });
});
