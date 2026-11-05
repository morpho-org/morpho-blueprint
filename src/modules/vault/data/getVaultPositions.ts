import "server-only";

import { type Address, getAddress } from "viem";
import { toAmountWithPrice } from "@/common/data/adapters/amount";
import { getTokenPriceUsd, getVaultAssetDecimals } from "@/common/data/rest/tokens";
import { getWalletTokenBalances } from "@/common/data/rpc/getWalletTokenBalances";
import { SECONDS_PER_DAY } from "@/common/utils/constants";
import { chunk, fetchAllMorphoRestPages, fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import type { VaultPosition, VaultPositionMap } from "@/modules/vault/vault.types";

export type { VaultPosition, VaultPositionMap };

interface RestVaultPosition {
  chain_id: number;
  vault_address: string;
  assets: string;
}

interface RestVaultRoot {
  data: { asset: { address: string; decimals: unknown } };
}

const ROUTE_PREFIX = {
  [Erc4626VaultProtocol.MorphoV2]: "/v0/vaults-v2",
  [Erc4626VaultProtocol.MorphoV1]: "/v0/vaults-v1",
} as const;

export const getVaultPositions = async (accountAddress: Address): Promise<VaultPositionMap> => {
  const chainIds = Object.keys(APP_CONFIG.supportedVaults).map(
    (chainId) => Number.parseInt(chainId) as SupportedChainId,
  );

  const perChain = await Promise.all(
    chainIds.map(async (chainId) => [chainId, await getVaultPositionsForChain(chainId, accountAddress)] as const),
  );

  const data = {} as VaultPositionMap;
  for (const [chainId, positions] of perChain) {
    data[chainId] = positions;
  }
  return data;
};

async function getVaultPositionsForChain(chainId: SupportedChainId, accountAddress: Address) {
  const configuredVaults = (APP_CONFIG.supportedVaults[chainId] ?? []).map((vault) => ({
    ...vault,
    address: getAddress(vault.address),
  }));

  // The user's positions are filtered to the configured vaults; every configured vault also
  // resolves its asset, so a vault with no position still gets a wallet balance ("In Wallet").
  const [positions, assets] = await Promise.all([
    Promise.all(
      [Erc4626VaultProtocol.MorphoV2, Erc4626VaultProtocol.MorphoV1].flatMap((protocol) =>
        chunk(configuredVaults.filter((vault) => vault.protocol === protocol).map((vault) => vault.address)).map(
          (vaultAddresses) =>
            fetchAllMorphoRestPages<RestVaultPosition>(`${ROUTE_PREFIX[protocol]}/users/${accountAddress}/positions`, {
              chain_ids: [chainId],
              vault_addresses: vaultAddresses,
            }),
        ),
      ),
    ),
    Promise.all(
      configuredVaults.map(async (vault) => {
        const root = await fetchMorphoRestResource<RestVaultRoot>(
          `${ROUTE_PREFIX[vault.protocol]}/${restSelector(chainId, vault.address)}`,
          undefined,
          // Only the vault's asset is read, and it never changes.
          { revalidate: SECONDS_PER_DAY },
        );
        const asset = root?.data.asset;
        const decimals = asset ? await getVaultAssetDecimals(chainId, asset) : null;
        return [
          vault.address,
          asset && decimals !== null ? { address: getAddress(asset.address), decimals } : null,
        ] as const;
      }),
    ),
  ]);

  const assetByVault = new Map<Address, { address: Address; decimals: number }>();
  for (const [vaultAddress, asset] of assets) {
    // Without valid decimals no amount can be formatted: the vault is skipped below, as if unknown.
    if (asset) assetByVault.set(vaultAddress, asset);
  }

  const assetsByVault = new Map<Address, string>();
  for (const position of positions.flat()) {
    if (position.chain_id === chainId) assetsByVault.set(getAddress(position.vault_address), position.assets);
  }

  const assetAddresses = Array.from(new Set(Array.from(assetByVault.values(), (asset) => asset.address)));
  const [prices, walletBalances] = await Promise.all([
    // No page to fall back to here: a rate-limited price shows no USD value.
    Promise.all(
      assetAddresses.map(
        async (address) =>
          [address, await getTokenPriceUsd(chainId, address, { throwWhenRateLimited: false })] as const,
      ),
    ),
    getWalletTokenBalances(chainId, accountAddress, assetAddresses),
  ]);
  const priceByAsset = new Map(prices);

  const result: Record<string, VaultPosition> = {};

  for (const configured of configuredVaults) {
    const vaultAddress = configured.address;
    const asset = assetByVault.get(vaultAddress);
    if (!asset) {
      console.warn(
        `Vault or its asset decimals not returned by the API, skipping position: ${chainId}:${vaultAddress}`,
      );
      continue;
    }

    const priceUsd = priceByAsset.get(asset.address) ?? null;
    const walletBalance = walletBalances.get(asset.address.toLowerCase());

    result[vaultAddress] = {
      vault: {
        chain: { id: chainId },
        asset: { priceUsd },
        vaultAddress,
      },
      // REST serves positions in asset units only; USD is priced here from the asset's price.
      assets: toAmountWithPrice(assetsByVault.get(vaultAddress) ?? 0, asset.decimals, priceUsd),
      walletAssetHolding:
        walletBalance === undefined ? null : { balance: toAmountWithPrice(walletBalance, asset.decimals, priceUsd) },
    };
  }

  return result;
}
