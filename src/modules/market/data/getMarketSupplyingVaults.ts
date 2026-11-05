import "server-only";

import { type Address, getAddress, type Hex } from "viem";
import { toBigInt } from "@/common/data/adapters/amount";
import { toCuratorInfo, toRoleAddress } from "@/common/data/adapters/entity";
import { getCuratorInfo } from "@/common/data/rest/curators";
import type { CuratorInfo } from "@/common/data/types";
import { fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { isBlueprintApiEnabled } from "@/common/utils/morphoApiConfig";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import type { RestMarketSupplier } from "./adapters";

interface RestVaultV1Allocations {
  data: { allocations: { market_id: Hex; supply_assets: string; supply_shares: string; supply_cap: string }[] };
}

type RestVaultV2Cap =
  | {
      cap_type: "market_v1";
      market_id: Hex;
      allocated_assets: string;
      absolute_cap: string;
      expected_supply_assets?: string | null;
    }
  | { cap_type: "adapter" | "collateral" | "unknown" };

interface RestVaultV2Allocations {
  data: { allocations: { caps: RestVaultV2Cap[] }[] };
}

/** A row of the Blueprint API's supplying-vaults list: Vault V2 only. */
interface BlueprintSupplyingVault {
  chain_id: number;
  vault_address: Address;
  supply_assets: string;
  last_indexed_block: string;
}

/** A row of Core's vault V2 list, filtered on the market's chain and loan token. */
interface RestVaultV2ListRow {
  vault_address: Address;
  name: string | null;
  curator: string | null;
}

interface RestCuratorListRow {
  name: string;
  image_url: string | null;
  addresses: { chain_id: number; curator_address: string }[];
}

interface RestVaultRoot {
  data: { name: string | null; curator: string | null; owner: string | null };
}

const VAULT_ROOT_PATH: Record<Erc4626VaultProtocol, string> = {
  [Erc4626VaultProtocol.MorphoV1]: "/v0/vaults-v1",
  [Erc4626VaultProtocol.MorphoV2]: "/v0/vaults-v2",
};

type Position = Pick<RestMarketSupplier, "supplyAssets" | "supplyShares" | "supplyCap">;

async function readVaultV1Position(selector: string, marketId: string): Promise<Position | null | undefined> {
  const response = await fetchMorphoRestResource<RestVaultV1Allocations>(`/v0/vaults-v1/${selector}/allocations`);
  if (!response) return undefined;
  const row = response.data.allocations.find((entry) => entry.market_id.toLowerCase() === marketId);
  if (!row) return null;
  return {
    supplyAssets: toBigInt(row.supply_assets),
    supplyShares: toBigInt(row.supply_shares).toString(),
    supplyCap: toBigInt(row.supply_cap),
  };
}

/**
 * A vault V2 can cap the same market through more than one adapter: the row sums every MarketV1
 * cap on it. The amount is the one accrued to now, or the stored one when REST serves an expected 0
 * for a position its accrual state predates (as the vault page reads it).
 */
async function readVaultV2Position(selector: string, marketId: string): Promise<Position | null | undefined> {
  const response = await fetchMorphoRestResource<RestVaultV2Allocations>(`/v0/vaults-v2/${selector}/allocations`);
  if (!response) return undefined;
  let supplyAssets = 0n;
  let supplyCap = 0n;
  for (const cap of response.data.allocations.flatMap((allocation) => allocation.caps)) {
    if (cap.cap_type !== "market_v1" || cap.market_id.toLowerCase() !== marketId) continue;
    const expected = cap.expected_supply_assets == null ? null : toBigInt(cap.expected_supply_assets);
    const allocated = toBigInt(cap.allocated_assets);
    supplyAssets += expected === null || (expected === 0n && allocated > 0n) ? allocated : expected;
    supplyCap += toBigInt(cap.absolute_cap);
  }
  // A cap left on a market the vault holds nothing in is not a supplier row (as with GraphQL).
  return supplyAssets === 0n ? null : { supplyAssets, supplyShares: "0", supplyCap };
}

/**
 * Every Vault V2 supplying the market, from the Blueprint API. `null` when the API is off or the
 * read fails (logged as a warning): the caller keeps the configured vaults only.
 */
async function getBlueprintSupplyingVaultsV2(chainId: SupportedChainId, marketId: Hex): Promise<Address[] | null> {
  if (!isBlueprintApiEnabled()) return null;
  const { data } = await tryCatch(
    fetchAllMorphoRestPages<BlueprintSupplyingVault>(
      `/v0/blueprint-app-api/blue/markets/${restSelector(chainId, marketId)}/supplying-vaults`,
      {},
      { api: "blueprint", quiet: true },
    ),
  );
  return data ? [...new Set(data.map((row) => getAddress(row.vault_address)))] : null;
}

/** The chain's curators by role address, from one list read. Empty on a failed read (logged). */
async function getChainCurators(chainId: SupportedChainId): Promise<Map<string, CuratorInfo>> {
  const curators = new Map<string, CuratorInfo>();
  const { data } = await tryCatch(
    fetchAllMorphoRestPages<RestCuratorListRow>("/v0/curators", { chain_ids: [chainId] }, { quiet: true }),
  );
  for (const curator of data ?? []) {
    const info = toCuratorInfo({ name: curator.name, image: curator.image_url, socials: [] });
    for (const { chain_id, curator_address } of curator.addresses) {
      if (chain_id === chainId && info) curators.set(curator_address.toLowerCase(), info);
    }
  }
  return curators;
}

/**
 * The vaults V2 the app does not configure but the Blueprint API lists as supplying the market,
 * kept to the ones Morpho lists (Core's vault V2 list, as GraphQL's `supplyingVaultV2s` was): the
 * route also serves unlisted vaults, often unnamed dust. Names and curators come from two list reads
 * (the chain's listed vaults V2 of the loan token, the chain's curators) rather than two reads per
 * vault, since a large market has dozens; amount and cap from each vault's allocations, as for a
 * configured vault. A failed list read throws: the caller keeps the configured vaults.
 */
async function readOtherVaultsV2(
  chainId: SupportedChainId,
  marketId: string,
  loanAsset: Address,
  addresses: readonly Address[],
): Promise<RestMarketSupplier[]> {
  if (addresses.length === 0) return [];
  const list = await fetchAllMorphoRestPages<RestVaultV2ListRow>(
    "/v0/vaults-v2",
    { chain_ids: [chainId], asset_addresses: [loanAsset] },
    { quiet: true },
  );
  const roots = new Map(list.map((row) => [getAddress(row.vault_address), row]));
  const vaults = addresses.flatMap((address) => {
    const root = roots.get(address);
    return root ? [{ address, name: root.name, curatorAddress: toRoleAddress(root.curator) }] : [];
  });
  if (vaults.length === 0) return [];

  const [positions, curators] = await Promise.all([
    Promise.all(vaults.map(({ address }) => readVaultV2Position(restSelector(chainId, address), marketId))),
    vaults.some(({ curatorAddress }) => curatorAddress) ? getChainCurators(chainId) : new Map<string, CuratorInfo>(),
  ]);

  return vaults.flatMap(({ address, name, curatorAddress }, index): RestMarketSupplier[] => {
    const position = positions[index];
    if (position === undefined) {
      console.warn(
        `Vault not returned by the API, left out of the market's suppliers: ${restSelector(chainId, address)}`,
      );
    }
    if (!position) return [];
    return [
      {
        protocol: Erc4626VaultProtocol.MorphoV2,
        vaultAddress: address,
        configured: false,
        name: name ?? address,
        curatorAddress,
        curator: curatorAddress ? (curators.get(curatorAddress.toLowerCase()) ?? null) : null,
        ...position,
      },
    ];
  });
}

/**
 * The configured vaults of the market's chain that supply it, from each vault's Core REST
 * allocations; name and curator are read only for those. A vault REST does not know is left out
 * with a warning. With the Blueprint API on, every other vault V2 it lists for the market is added
 * (`configured: false`: the app has no page for it). The API lists no V1 vault, so V1 stays configured
 * only, and with it the borrow flow's public-allocator candidates.
 */
export async function getMarketSupplyingVaults(
  chainId: SupportedChainId,
  marketId: Hex,
  loanAsset: Address,
): Promise<RestMarketSupplier[]> {
  const id = marketId.toLowerCase();
  const vaults = APP_CONFIG.supportedVaults[chainId] ?? [];
  const configured = new Set(vaults.map(({ address }) => getAddress(address)));
  const curators = new Map<string, Promise<CuratorInfo | null>>();
  const curatorOf = (address: Address) => {
    const key = address.toLowerCase();
    const pending = curators.get(key) ?? getCuratorInfo(chainId, address);
    curators.set(key, pending);
    return pending;
  };

  const [rows, others] = await Promise.all([
    Promise.all(
      vaults.map(async ({ address, protocol }): Promise<RestMarketSupplier | null> => {
        const selector = restSelector(chainId, address);
        const position = await (protocol === Erc4626VaultProtocol.MorphoV1
          ? readVaultV1Position(selector, id)
          : readVaultV2Position(selector, id));
        if (position === undefined) {
          console.warn(`Vault not returned by the API, left out of the market's suppliers: ${selector}`);
          return null;
        }
        if (position === null) return null;

        const root = await fetchMorphoRestResource<RestVaultRoot>(`${VAULT_ROOT_PATH[protocol]}/${selector}`);
        if (!root) {
          console.warn(`Vault not returned by the API, left out of the market's suppliers: ${selector}`);
          return null;
        }
        // A cleared curator comes back as the zero address. A V1 vault falls back to its owner, as the
        // vault page resolves it; a V2 vault's owner is not its curator.
        const curatorAddress =
          toRoleAddress(root.data.curator) ??
          (protocol === Erc4626VaultProtocol.MorphoV1 ? toRoleAddress(root.data.owner) : null);
        return {
          protocol,
          vaultAddress: address,
          configured: true,
          name: root.data.name ?? address,
          curatorAddress,
          curator: curatorAddress ? await curatorOf(curatorAddress) : null,
          ...position,
        };
      }),
    ),
    getBlueprintSupplyingVaultsV2(chainId, marketId)
      .then((addresses) =>
        readOtherVaultsV2(
          chainId,
          id,
          loanAsset,
          (addresses ?? []).filter((address) => !configured.has(address)),
        ),
      )
      // The extra rows are optional: a failed read keeps the configured ones.
      .catch((error): RestMarketSupplier[] => {
        console.warn(`Other supplying vaults left out for ${restSelector(chainId, marketId)} - ${error}`);
        return [];
      }),
  ]);
  return [...rows.filter((row): row is RestMarketSupplier => row !== null), ...others];
}
