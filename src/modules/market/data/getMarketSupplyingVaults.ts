import "server-only";

import type { Address, Hex } from "viem";
import { toBigInt } from "@/common/data/adapters/amount";
import { toRoleAddress } from "@/common/data/adapters/entity";
import { getCuratorInfo } from "@/common/data/rest/curators";
import type { CuratorInfo } from "@/common/data/types";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
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
 * The configured vaults of the market's chain that supply it, from each vault's Core REST
 * allocations; name and curator are read only for those. A vault REST does not know is left out
 * with a warning.
 */
export async function getMarketSupplyingVaults(
  chainId: SupportedChainId,
  marketId: Hex,
): Promise<RestMarketSupplier[]> {
  const id = marketId.toLowerCase();
  const vaults = APP_CONFIG.supportedVaults[chainId] ?? [];
  const curators = new Map<string, Promise<CuratorInfo | null>>();
  const curatorOf = (address: Address) => {
    const key = address.toLowerCase();
    const pending = curators.get(key) ?? getCuratorInfo(chainId, address);
    curators.set(key, pending);
    return pending;
  };

  const rows = await Promise.all(
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
        name: root.data.name ?? address,
        curatorAddress,
        curator: curatorAddress ? await curatorOf(curatorAddress) : null,
        ...position,
      };
    }),
  );
  return rows.filter((row): row is RestMarketSupplier => row !== null);
}
