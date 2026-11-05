import "server-only";

import { type Address, formatUnits, getAddress, zeroAddress } from "viem";
import { toBigInt } from "@/common/data/adapters/amount";
import { toRoleAddress } from "@/common/data/adapters/entity";
import type { ChainInfo } from "@/common/data/types";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { getMarketInfos } from "@/modules/market/data/getMarketInfos";
import type { MerklRewardIndex } from "@/modules/reward/data/merklRewardApys";
import type { MorphoVaultV1 } from "@/modules/vault/vault.types";
import { type RestVaultV1Allocation, toRestVaultMarketAllocations, withdrawQueueAllocations } from "./adapters";
import { fetchVaultApyAverages } from "./fetchVaultApyAverages";

export type VaultV1Details = Pick<
  MorphoVaultV1,
  | "marketAllocations"
  | "totalLiquidity"
  | "apyAverages"
  | "performanceFeeRaw"
  | "feeRecipientAddress"
  | "ownerAddress"
  | "curatorAddress"
  | "guardianAddress"
>;

/** What the caller's summary read already holds, so the details do not read it again. */
export interface VaultV1DetailsContext {
  chain: ChainInfo;
  /** Decimals from `getVaultAssetDecimals`, the price from the summary's one price read. */
  asset: { address: Address; decimals: number; priceUsd: number | null };
  /** `/v0/vaults-v1/{vault}` as the summary read it. */
  root: {
    fee_wad: string | null;
    fee_recipient: string | null;
    owner: string;
    curator: string | null;
    guardian: string | null;
  };
  /** `/v0/vaults-v1/{vault}/state` as the summary read it. */
  state: { total_assets: string; withdrawable_assets: string };
}

/**
 * The vault page's detail fields for a vault V1, from Core REST: fees and roles, the market
 * allocations, the withdrawable liquidity and the realized APY averages the chart reference line
 * reads. `null` when REST does not know the vault. The root, state, asset decimals and price come
 * from the caller's summary read (`null` when it has no such vault).
 */
export async function getVaultV1Details(
  chainId: number,
  vaultAddress: Address,
  contextPromise: Promise<VaultV1DetailsContext | null>,
  // The caller's Merkl read, shared with the market reads; it never rejects (native APYs on failure).
  rewardIndexPromise: Promise<MerklRewardIndex>,
): Promise<VaultV1Details | null> {
  const selector = restSelector(chainId, vaultAddress);
  const [allocations, apyAverages] = await Promise.all([
    fetchMorphoRestResource<{ data: { allocations: RestVaultV1Allocation[] } }>(
      `/v0/vaults-v1/${selector}/allocations`,
    ),
    fetchVaultApyAverages(`/v0/vaults-v1/${selector}/apy-averages`),
  ]);
  const context = await contextPromise;
  if (!allocations || !context) return null;

  const { root, state } = context;
  const { decimals, priceUsd } = context.asset;
  const rows = withdrawQueueAllocations(allocations.data.allocations);
  const markets = await getMarketInfos(
    chainId,
    context.chain,
    rows.map((row) => row.market_id),
    rewardIndexPromise,
    // The vault asset is the loan token of its markets: its price is the one the summary read.
    new Map([[getAddress(context.asset.address), priceUsd]]),
  );
  const liquidity = Number(formatUnits(toBigInt(state.withdrawable_assets), decimals));

  return {
    marketAllocations: toRestVaultMarketAllocations(rows, markets, decimals, priceUsd, toBigInt(state.total_assets)),
    totalLiquidity: { usd: priceUsd == null ? null : liquidity * priceUsd },
    apyAverages,
    // REST serves null for a fee never set: 0, as GraphQL did.
    performanceFeeRaw: Number(formatUnits(toBigInt(root.fee_wad), 18)),
    // A zero fee recipient is no fee recipient: the row is hidden, as for an unset one.
    feeRecipientAddress: toRoleAddress(root.fee_recipient),
    // The info panel shows an unset or cleared role as the zero address, as GraphQL served it.
    ownerAddress: toRoleAddress(root.owner) ?? zeroAddress,
    curatorAddress: toRoleAddress(root.curator) ?? zeroAddress,
    guardianAddress: toRoleAddress(root.guardian) ?? zeroAddress,
  };
}
