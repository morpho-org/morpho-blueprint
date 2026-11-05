import "server-only";

import { Time } from "@morpho-org/morpho-ts";
import { type Address, formatUnits, getAddress, type Hex, zeroAddress } from "viem";
import { toAmountWithPrice, toBigInt, toRatio } from "@/common/data/adapters/amount";
import { assembleApyWithRewards } from "@/common/data/adapters/apy";
import { getTokenInfo } from "@/common/data/rest/tokens";
import type { ApyAverages, ChainInfo, TokenInfo } from "@/common/data/types";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { restApyLookback } from "@/common/utils/timeframe";
import { getMarketInfos } from "@/modules/market/data/getMarketInfos";
import type { MarketInfo } from "@/modules/market/market.types";
import { type MerklRewardIndex, vaultRewardApys } from "@/modules/reward/data/merklRewardApys";
import type {
  MorphoVaultV2,
  UnderlyingMorphoVaultV1,
  VaultMarketAllocation,
  VaultV2AdapterCap,
  VaultV2Allocation,
  VaultV2MarketCap,
} from "@/modules/vault/vault.types";
import { matchRestVaultV2Adapter, type RestVaultV2AdapterKind } from "./matchVaultV2Adapter";

interface RestSentinels {
  data: { role_address: Address }[];
}

interface RestApyAverage {
  data: { apy: number | null };
}

type RestCap =
  | {
      cap_type: "adapter";
      allocated_assets: string;
      absolute_cap: string;
      relative_cap_wad: string;
      real_assets?: string | null;
    }
  | {
      cap_type: "market_v1";
      market_id: Hex;
      allocated_assets: string;
      absolute_cap: string;
      relative_cap_wad: string;
      expected_supply_assets?: string | null;
    }
  // Other scopes (collateral, unknown) do not belong to one adapter row.
  | { cap_type: "collateral" | "unknown" };

interface RestVaultV2Allocations {
  data: {
    allocations: {
      adapter_address: Address;
      adapter_kind: RestVaultV2AdapterKind;
      target: { type: string; vault_address?: Address };
      caps: RestCap[];
    }[];
  };
}

interface RestVaultV1 {
  data: { name: string | null; asset: { address: Address } };
}

interface RestVaultV1Allocations {
  data: { allocations: { market_id: Hex; supply_assets: string; supply_shares: string; supply_cap: string }[] };
}

type MarketCapRow = Extract<RestCap, { cap_type: "market_v1" }>;
type AdapterCapRow = Extract<RestCap, { cap_type: "adapter" }>;

const APY_AVERAGE_LOOKBACKS = {
  sevenDays: "seven_days",
  thirtyDays: "thirty_days",
  ninetyDays: "ninety_days",
  inception: "inception",
} as const satisfies Record<keyof ApyAverages, string>;

export type VaultV2Details = Pick<
  MorphoVaultV2,
  | "allocations"
  | "totalAssets"
  | "apyAverages"
  | "curatorAddress"
  | "sentinelAddresses"
  | "performanceFee"
  | "managementFee"
>;

/** A WAD fee as the unitless fraction the UI formats. REST serves null for a fee never set: 0. */
function toFee(wad: string | null): { formatted: string } {
  return { formatted: formatUnits(toBigInt(wad), 18) };
}

/**
 * REST serves the management fee as the on-chain per-second WAD rate; the UI shows it annual, as
 * GraphQL served it (`ratePerSecond * Time.s.from.y(1)`). Scaled in bigint before formatting.
 */
function toAnnualManagementFee(perSecondWad: string | null): { formatted: string } {
  return { formatted: formatUnits(toBigInt(perSecondWad) * Time.s.from.y(1n), 18) };
}

// The cap amount REST accrues to now, falling back to the one stored at the last (de)allocation.
// REST serves an expected 0 when its accrual state predates the position; the stored amount is then
// the better estimate.
const marketCapAssets = (cap: MarketCapRow) =>
  cap.expected_supply_assets == null ||
  (toBigInt(cap.expected_supply_assets) === 0n && toBigInt(cap.allocated_assets) > 0n)
    ? cap.allocated_assets
    : cap.expected_supply_assets;
const adapterCapAssets = (cap: AdapterCapRow) => cap.real_assets ?? cap.allocated_assets;

/** What the caller's summary read already holds, so the details do not read it again. */
export interface VaultV2DetailsContext {
  chain: ChainInfo;
  /** Decimals from `getVaultAssetDecimals`, the price from the summary's one price read. */
  asset: { address: Address; decimals: number; priceUsd: number | null };
  /** `/v0/vaults-v2/{vault}` as the summary read it. */
  root: { curator: string | null; performance_fee_wad: string | null; management_fee_wad: string | null };
  /** `/v1/vaults-v2/{vault}/state` as the summary read it. */
  state: { idle_assets: string };
}

/**
 * The vault page's detail fields for a vault V2, from Core REST: fees and roles, the adapter and cap
 * breakdown, and the realized APY averages the chart reference line reads. `null` when REST does not
 * know the vault. The root, state, asset decimals and price come from the caller's summary read
 * (`null` when it has no such vault), awaited only once the other vault-level reads are in.
 */
export async function getVaultV2Details(
  chainId: number,
  vaultAddress: Address,
  contextPromise: Promise<VaultV2DetailsContext | null>,
  // The caller's Merkl read, shared with the market reads; it never rejects (native APYs on failure).
  rewardIndexPromise: Promise<MerklRewardIndex>,
): Promise<VaultV2Details | null> {
  const selector = restSelector(chainId, vaultAddress);
  const [allocations, sentinels, apyAverages] = await Promise.all([
    fetchMorphoRestResource<RestVaultV2Allocations>(`/v0/vaults-v2/${selector}/allocations`),
    fetchMorphoRestResource<RestSentinels>(`/v0/vaults-v2/${selector}/sentinels`),
    fetchApyAverages(selector),
  ]);
  const context = await contextPromise;
  if (!allocations || !context) return null;

  const { root, state } = context;
  const { decimals, priceUsd: price } = context.asset;
  const adapters = allocations.data.allocations;

  // A vault V1 held through an adapter expands into its own market allocations.
  const vaultV1Reads = await Promise.all(
    adapters.flatMap((adapter) =>
      adapter.adapter_kind === "morpho_vault_v1" && adapter.target.vault_address
        ? [readVaultV1(chainId, adapter.adapter_address, adapter.target.vault_address)]
        : [],
    ),
  );

  // Only markets the vault holds assets in are shown, so only those need a market read.
  const heldMarketIds = adapters.flatMap((adapter) =>
    adapter.caps.flatMap((cap) =>
      cap.cap_type === "market_v1" && toBigInt(marketCapAssets(cap)) > 0n ? [cap.market_id] : [],
    ),
  );
  const vaultV1MarketIds = vaultV1Reads.flatMap((read) => read?.allocations.map((row) => row.market_id) ?? []);
  const [markets, vaultV1Assets, rewardIndex] = await Promise.all([
    // The vault asset is the loan token of its markets: its price is the one the summary read.
    getMarketInfos(
      chainId,
      context.chain,
      [...heldMarketIds, ...vaultV1MarketIds],
      rewardIndexPromise,
      new Map([[getAddress(context.asset.address), price]]),
    ),
    Promise.all(
      [...new Set(vaultV1Reads.flatMap((read) => (read ? [getAddress(read.vault.asset.address)] : [])))].map(
        async (address) => [address, await getTokenInfo(chainId, address)] as const,
      ),
    ),
    rewardIndexPromise,
  ]);
  const tokenByAddress = new Map(vaultV1Assets);
  const vaultV1ByAdapter = new Map<string, UnderlyingMorphoVaultV1>();
  for (const read of vaultV1Reads) {
    const asset = read && tokenByAddress.get(getAddress(read.vault.asset.address));
    if (!read || !asset) continue;
    vaultV1ByAdapter.set(
      read.adapterAddress.toLowerCase(),
      toUnderlyingVaultV1(read, asset, context.chain, markets, price, rewardIndex),
    );
  }

  const toMarketCaps = (caps: RestCap[]): VaultV2MarketCap[] =>
    caps.flatMap((cap): VaultV2MarketCap[] => {
      if (cap.cap_type !== "market_v1") return [];
      const allocation = marketCapAssets(cap);
      // A curator can leave a cap on a market the vault has not allocated to; the table shows only
      // markets the vault is in, as before.
      if (toBigInt(allocation) === 0n) return [];
      const market = markets.get(cap.market_id.toLowerCase());
      if (!market) return [];
      return [
        {
          allocation: toAmountWithPrice(allocation, decimals, price),
          absoluteCap: toAmountWithPrice(cap.absolute_cap, decimals, price),
          relativeCap: toRatio(cap.relative_cap_wad),
          market,
        },
      ];
    });

  const rows = adapters.map((adapter): VaultV2Allocation => {
    const adapterCap = adapter.caps.find((cap): cap is AdapterCapRow => cap.cap_type === "adapter");
    const marketCaps = toMarketCaps(adapter.caps);
    const base = {
      adapterAddress: getAddress(adapter.adapter_address),
      adapterCap: toAdapterCap(adapterCap, marketCaps, decimals, price),
    };

    return matchRestVaultV2Adapter<VaultV2Allocation>(adapter, {
      marketV1: () => ({ ...base, __typename: "MarketV1Adapter", name: "Morpho Market Adapter", marketCaps }),
      vaultV1: () => {
        const vault = vaultV1ByAdapter.get(adapter.adapter_address.toLowerCase()) ?? null;
        return { ...base, __typename: "Erc4626VaultAdapter", name: vault?.name ?? "Morpho Vault V1 Adapter", vault };
      },
      // REST serves no handle on the vault V2 an adapter wraps, so this row does not expand.
      vaultV2: () => ({ ...base, __typename: "Erc4626VaultAdapter", name: "Morpho Vault V2 Adapter", vault: null }),
      unknown: () => ({ ...base, __typename: "Erc4626VaultAdapter", name: "Vault Adapter", vault: null }),
    });
  });

  // The current total is the accrued adapter assets plus the idle assets, so the breakdown shares
  // add up to 100%. REST lists every adapter in one response, so the sum is never truncated.
  const totalRaw = rows.reduce(
    (sum, row) => sum + toBigInt(row.adapterCap?.allocation.raw),
    toBigInt(state.idle_assets),
  );

  return {
    allocations: rows,
    totalAssets: toAmountWithPrice(totalRaw, decimals, price),
    apyAverages,
    curatorAddress: getAddress(root.curator ?? zeroAddress),
    sentinelAddresses: (sentinels?.data ?? []).map((sentinel) => getAddress(sentinel.role_address)),
    performanceFee: toFee(root.performance_fee_wad),
    managementFee: toAnnualManagementFee(root.management_fee_wad),
  };
}

function toAdapterCap(
  cap: AdapterCapRow | undefined,
  marketCaps: VaultV2MarketCap[],
  decimals: number,
  price: number | null,
): VaultV2AdapterCap {
  if (!cap) {
    // Defensive: every adapter should carry an adapter cap. Fall back to what its markets hold so
    // the allocation column still renders, with no cap information.
    const held = marketCaps.reduce((sum, marketCap) => sum + toBigInt(marketCap.allocation.raw), 0n);
    return {
      allocation: toAmountWithPrice(held, decimals, price),
      relativeCap: toRatio(0),
      absoluteCap: toAmountWithPrice(0, decimals, null),
    };
  }
  return {
    allocation: toAmountWithPrice(adapterCapAssets(cap), decimals, price),
    // `relative_cap_wad` is WAD-scaled, so `formatted` is the [0, 1] fraction the UI renders as a percent.
    relativeCap: toRatio(cap.relative_cap_wad),
    absoluteCap: toAmountWithPrice(cap.absolute_cap, decimals, price),
  };
}

/** One realized net APY per chart range; null when REST has none (a vault younger than the window). */
async function fetchApyAverages(selector: string): Promise<ApyAverages> {
  const entries = await Promise.all(
    Object.entries(APY_AVERAGE_LOOKBACKS).map(async ([key, lookback]) => {
      const response = await fetchMorphoRestResource<RestApyAverage>(`/v1/vaults-v2/${selector}/apy-averages`, {
        lookback,
      });
      return [key, response?.data.apy ?? null] as const;
    }),
  );
  const byKey = Object.fromEntries(entries);
  return {
    sevenDays: byKey.sevenDays ?? null,
    thirtyDays: byKey.thirtyDays ?? null,
    ninetyDays: byKey.ninetyDays ?? null,
    inception: byKey.inception ?? null,
  };
}

type VaultV1Read = {
  adapterAddress: Address;
  vaultAddress: Address;
  vault: RestVaultV1["data"];
  allocations: RestVaultV1Allocations["data"]["allocations"];
  apy: number | null;
};

async function readVaultV1(
  chainId: number,
  adapterAddress: Address,
  vaultAddress: Address,
): Promise<VaultV1Read | null> {
  const selector = restSelector(chainId, vaultAddress);
  const [vault, allocations, apy] = await Promise.all([
    fetchMorphoRestResource<RestVaultV1>(`/v0/vaults-v1/${selector}`),
    fetchMorphoRestResource<RestVaultV1Allocations>(`/v0/vaults-v1/${selector}/allocations`),
    fetchMorphoRestResource<RestApyAverage>(`/v0/vaults-v1/${selector}/apy-averages`, {
      lookback: restApyLookback,
    }),
  ]);
  if (!vault || !allocations) {
    console.warn(`Vault V1 behind adapter ${adapterAddress} not returned by the API, row left unexpanded.`);
    return null;
  }
  return {
    adapterAddress,
    vaultAddress,
    vault: vault.data,
    allocations: allocations.data.allocations,
    apy: apy?.data.apy ?? null,
  };
}

function toUnderlyingVaultV1(
  read: VaultV1Read,
  asset: TokenInfo,
  chain: ChainInfo,
  markets: ReadonlyMap<string, MarketInfo>,
  price: number | null,
  rewardIndex: MerklRewardIndex,
): UnderlyingMorphoVaultV1 {
  const decimals = asset.decimals;
  const totalRaw = read.allocations.reduce((sum, row) => sum + toBigInt(row.supply_assets), 0n);
  const total = Number(formatUnits(totalRaw, decimals));

  return {
    __typename: "MorphoVault",
    vaultAddress: getAddress(read.vaultAddress),
    name: read.vault.name ?? read.vaultAddress,
    chain,
    asset,
    apy: assembleApyWithRewards(read.apy, vaultRewardApys(rewardIndex, read.vaultAddress, "v1")),
    totalAssets: toAmountWithPrice(totalRaw, decimals, price),
    marketAllocations: read.allocations.flatMap((row): VaultMarketAllocation[] => {
      const market = markets.get(row.market_id.toLowerCase());
      if (!market) return [];
      const supply = toAmountWithPrice(row.supply_assets, decimals, price);
      return [
        {
          enabled: toBigInt(row.supply_cap) > 0n,
          vaultSupplyShare: total > 0 ? Number(supply.formatted) / total : 0,
          position: { supplyAmount: supply, supplyShares: toBigInt(row.supply_shares).toString() },
          supplyCap: toAmountWithPrice(row.supply_cap, decimals, price),
          market,
        },
      ];
    }),
  };
}
