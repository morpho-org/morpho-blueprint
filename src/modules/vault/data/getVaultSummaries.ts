import "server-only";

import { cache } from "react";
import { type Address, getAddress, type Hex, zeroAddress } from "viem";
import { toRoleAddress } from "@/common/data/adapters/entity";
import { getCurator, getCuratorsAumUsd, type RestCurator } from "@/common/data/rest/curators";
import { getTokenInfo, getTokenMetadata, getTokenPriceUsd, getVaultAssetDecimals } from "@/common/data/rest/tokens";
import type { TokenInfo } from "@/common/data/types";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";
import { restApyLookback } from "@/common/utils/timeframe";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { getMerklRewardIndex } from "@/modules/reward/data/getMerklRewardIndex";
import { emptyMerklRewardIndex, type MerklRewardIndex, vaultRewardApys } from "@/modules/reward/data/merklRewardApys";
import { withRewardTokenMetadata } from "@/modules/reward/data/rewardTokenMetadata";
import { normalizeVault } from "@/modules/vault/utils/normalizeVault";
import type { MorphoVaultV1Summary, MorphoVaultV2Summary, VaultSummary } from "@/modules/vault/vault.types";
import {
  type Adapted,
  type RestVaultV1Allocation,
  toRestVaultCollateralAllocations,
  toRestVaultV1Summary,
  toRestVaultV2Summary,
  withdrawQueueAllocations,
} from "./adapters";

// Both protocols' summaries come from Core REST, one set of reads per vault; the REST client caps
// the calls in flight.

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

/** `/v0/vaults-v1/{vault}`. Core REST serves the asset's name, symbol and decimals as nullable. */
interface RestVaultV1Root {
  data: {
    address: string;
    name: string | null;
    asset: { address: string; decimals: unknown; name: string | null; symbol: string | null };
    fee_wad: string | null;
    fee_recipient: string | null;
    owner: string;
    curator: string | null;
    guardian: string | null;
  };
}

interface RestVaultV1State {
  data: { total_assets: string; withdrawable_assets: string };
}

interface RestMarketRoot {
  chain_id: number;
  market_id: Hex;
  collateral_token: Address;
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
  /** The curator's registry id, which keys the AUM read; `null` without a known curator. */
  curatorId: string | null;
}

/** One vault V1's summary with the root and state it was built from, which the vault page reuses. */
export interface VaultV1SummaryRead {
  summary: Adapted<MorphoVaultV1Summary>;
  root: RestVaultV1Root["data"];
  state: RestVaultV1State["data"];
  /** The curator's registry id, which keys the AUM read; `null` without a known curator. */
  curatorId: string | null;
}

/**
 * Sets each summary's curator AUM from one batched Blueprint API read. A summary keeps it unset
 * (the UI hides it) when the Blueprint API is off, the read fails, or the route does not know the
 * curator.
 */
async function withCuratorsAum<R extends { summary: { curatorAum?: number }; curatorId: string | null }>(
  reads: readonly R[],
): Promise<R[]> {
  const aums = await getCuratorsAumUsd(reads.flatMap(({ curatorId }) => (curatorId ? [curatorId] : [])));
  return reads.map((read) => {
    const curatorAum = read.curatorId ? aums.get(read.curatorId) : undefined;
    return curatorAum === undefined ? read : { ...read, summary: { ...read.summary, curatorAum } };
  });
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
async function getVaultDescriptions(
  kind: "vaults-v1" | "vaults-v2",
  vaults: readonly { chainId: number; address: string }[],
) {
  const descriptions = new Map<string, string | null>();
  if (!isBlueprintApiEnabled() || vaults.length === 0) return descriptions;
  const { data } = await tryCatch(
    Promise.all(
      chunk(vaults.map((vault) => restSelector(vault.chainId, vault.address))).map((selectors) =>
        fetchAllMorphoRestPages<RestVaultMetadata>(
          `/v0/blueprint-app-api/${kind}/metadata`,
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
  const curatorOf = once(getCurator);
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
    const curatorRole = toRoleAddress(root.data.curator);
    const [token, priceUsd, curator] = await Promise.all([
      tokenOf(chainId, asset),
      priceOf(chainId, asset),
      curatorRole ? curatorOf(chainId, curatorRole) : Promise.resolve<RestCurator | null>(null),
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
      curator: curator?.info ?? null,
      curatorId: curator?.id ?? null,
      decimals,
    };
  };

  const [descriptions, reads] = await Promise.all([
    getVaultDescriptions("vaults-v2", vaults),
    Promise.all(vaults.map(readVault)),
  ]);

  return reads.flatMap((read): VaultV2SummaryRead[] => {
    if (!read) return [];
    const { decimals, state, curatorId, ...source } = read;
    // Formatting with a guessed scale would misstate every amount by orders of magnitude.
    if (decimals === null) {
      console.warn(`Vault asset decimals unknown: ${read.chainId}:${read.root.address}`);
      return [];
    }
    const description = descriptions.get(vaultKey(read.chainId, read.root.address)) ?? null;
    return [{ summary: toRestVaultV2Summary({ ...source, decimals, description }), root: read.root, state, curatorId }];
  });
}

/**
 * The collateral token of each market, by lowercase market id: `null` for an idle market, absent for
 * a market or token REST cannot describe. Market params never change: a day cache.
 */
async function getMarketCollaterals(
  chainId: number,
  marketIds: readonly Hex[],
  tokenOf: (chainId: number, address: Address) => Promise<TokenInfo | null>,
): Promise<Map<string, TokenInfo | null>> {
  const collaterals = new Map<string, TokenInfo | null>();
  if (marketIds.length === 0) return collaterals;
  const roots = await Promise.all(
    chunk([...new Set(marketIds)]).map((ids) =>
      fetchAllMorphoRestPages<RestMarketRoot>(
        "/v0/blue/markets",
        { chain_id: [chainId], market_id: ids },
        { revalidate: SECONDS_PER_DAY },
      ),
    ),
  );
  await Promise.all(
    roots.flat().map(async (root) => {
      if (root.chain_id !== chainId) return;
      const collateral = getAddress(root.collateral_token);
      const token = collateral === zeroAddress ? null : await tokenOf(chainId, collateral);
      if (collateral === zeroAddress || token) collaterals.set(root.market_id.toLowerCase(), token);
    }),
  );
  return collaterals;
}

/**
 * The adapted (not yet normalized) vault V1 summaries, in input order, without the vaults REST does
 * not know. With `withCollateral`, each also carries the trimmed market allocations the earn-table
 * exposure tooltip reads; a failed read there leaves the tooltip empty rather than failing the page.
 * The curator is the curator role's, else the owner's, as GraphQL resolved it.
 */
async function getVaultV1Summaries(
  vaults: readonly { chainId: number; address: string }[],
  rewardIndexes: Map<number, Promise<MerklRewardIndex>>,
  { withCollateral }: { withCollateral: boolean },
): Promise<VaultV1SummaryRead[]> {
  const tokenOf = once(getTokenMetadata);
  const priceOf = once(getTokenPriceUsd);
  const curatorOf = once(getCurator);
  const collateralTokenOf = once(getTokenInfo);
  for (const { chainId } of vaults) {
    if (!rewardIndexes.has(chainId)) rewardIndexes.set(chainId, getMerklRewardIndex(chainId));
  }

  const readVault = async ({ chainId, address }: { chainId: number; address: string }) => {
    const selector = restSelector(chainId, address);
    const [root, state, apy, allocations, rewardIndex] = await Promise.all([
      fetchMorphoRestResource<RestVaultV1Root>(`/v0/vaults-v1/${selector}`),
      fetchMorphoRestResource<RestVaultV1State>(`/v0/vaults-v1/${selector}/state`),
      fetchMorphoRestResource<{ data: { apy: number | null } }>(`/v0/vaults-v1/${selector}/apy-averages`, {
        lookback: restApyLookback,
      }),
      withCollateral
        ? tryCatch(
            fetchMorphoRestResource<{ data: { allocations: RestVaultV1Allocation[] } }>(
              `/v0/vaults-v1/${selector}/allocations`,
              undefined,
              { quiet: true },
            ),
          )
        : null,
      rewardIndexes.get(chainId) ?? emptyMerklRewardIndex(),
    ]);
    if (!root || !state) return null;

    const asset = getAddress(root.data.asset.address);
    // A cleared curator role comes back as null or the zero address: both fall back to the owner.
    const curatorRole = toRoleAddress(root.data.curator) ?? toRoleAddress(root.data.owner);
    const [token, priceUsd, curator] = await Promise.all([
      tokenOf(chainId, asset),
      priceOf(chainId, asset),
      curatorRole ? curatorOf(chainId, curatorRole) : Promise.resolve<RestCurator | null>(null),
    ]);
    const decimals = await getVaultAssetDecimals(chainId, root.data.asset, token);
    // A vault with unknown decimals is dropped below: no reward metadata read for it.
    const rewardApys = decimals === null ? [] : vaultRewardApys(rewardIndex, getAddress(root.data.address), "v1");
    return {
      chainId,
      root: root.data,
      state: state.data,
      totalAssets: state.data.total_assets,
      apy: apy?.data.apy ?? null,
      rewards: await withRewardTokenMetadata(rewardIndex, rewardApys),
      token,
      priceUsd,
      curator: curator?.info ?? null,
      curatorId: curator?.id ?? null,
      allocations: withdrawQueueAllocations(allocations?.data?.data.allocations ?? []),
      decimals,
    };
  };

  const [descriptions, reads] = await Promise.all([
    getVaultDescriptions("vaults-v1", vaults),
    Promise.all(vaults.map(readVault)),
  ]);

  // One market-params read per chain for every vault's tooltip.
  const collateralsByChain = new Map<number, Map<string, TokenInfo | null>>();
  if (withCollateral) {
    const marketIdsByChain = new Map<number, Hex[]>();
    for (const read of reads) {
      if (!read) continue;
      const ids = marketIdsByChain.get(read.chainId) ?? [];
      ids.push(...read.allocations.map((row) => row.market_id));
      marketIdsByChain.set(read.chainId, ids);
    }
    await Promise.all(
      Array.from(marketIdsByChain.entries()).map(async ([chainId, ids]) => {
        const { data, error } = await tryCatch(getMarketCollaterals(chainId, ids, collateralTokenOf));
        if (error) console.warn(`Vault V1 exposure unavailable on chain ${chainId}: ${error.message}`);
        collateralsByChain.set(chainId, data ?? new Map());
      }),
    );
  }

  return reads.flatMap((read): VaultV1SummaryRead[] => {
    if (!read) return [];
    const { decimals, state, allocations, curatorId, ...source } = read;
    // Formatting with a guessed scale would misstate every amount by orders of magnitude.
    if (decimals === null) {
      console.warn(`Vault asset decimals unknown: ${read.chainId}:${read.root.address}`);
      return [];
    }
    const description = descriptions.get(vaultKey(read.chainId, read.root.address)) ?? null;
    const marketAllocations = toRestVaultCollateralAllocations(
      allocations,
      collateralsByChain.get(read.chainId) ?? new Map(),
      decimals,
      read.priceUsd,
      state.total_assets,
    );
    return [
      {
        summary: toRestVaultV1Summary({ ...source, decimals, description }, marketAllocations),
        root: read.root,
        state,
        curatorId,
      },
    ];
  });
}

/**
 * One vault V1's summary (the vault page header) with the root and state behind it, without the
 * exposure tooltip reads (the page shows the full allocations instead). `null` when REST does not
 * know the vault. The caller passes its Merkl read so the page makes one.
 */
export async function getVaultV1Summary(
  chainId: number,
  address: Address,
  rewardIndex: Promise<MerklRewardIndex>,
): Promise<VaultV1SummaryRead | null> {
  const [summary] = await withCuratorsAum(
    await getVaultV1Summaries([{ chainId, address }], new Map([[chainId, rewardIndex]]), { withCollateral: false }),
  );
  return summary ?? null;
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
  const [summary] = await withCuratorsAum(
    await getVaultV2Summaries([{ chainId, address }], new Map([[chainId, rewardIndex]])),
  );
  return summary ?? null;
}

export type { VaultSummary };

export const getVaultSummaries = cache(async (): Promise<VaultSummary[]> => {
  const configuredVaults = Object.entries(APP_CONFIG.supportedVaults).flatMap(([chainId, vaults]) =>
    vaults.map((vault) => ({ chainId: Number.parseInt(chainId) as SupportedChainId, ...vault })),
  );

  // One Merkl read per chain, shared by both protocols' vaults on it.
  const rewardIndexes = new Map<number, Promise<MerklRewardIndex>>();
  const [v2Summaries, v1Summaries] = await Promise.all([
    getVaultV2Summaries(
      configuredVaults.filter((vault) => vault.protocol === Erc4626VaultProtocol.MorphoV2),
      rewardIndexes,
    ),
    getVaultV1Summaries(
      configuredVaults.filter((vault) => vault.protocol === Erc4626VaultProtocol.MorphoV1),
      rewardIndexes,
      { withCollateral: true },
    ),
  ]);

  // One AUM read for both protocols' curators.
  const byKey = new Map<string, VaultSummary>();
  for (const { summary } of await withCuratorsAum([...v2Summaries, ...v1Summaries])) {
    byKey.set(vaultKey(summary.chain.id, summary.vaultAddress), normalizeVault(summary));
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
