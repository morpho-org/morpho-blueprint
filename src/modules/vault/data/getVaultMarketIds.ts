import "server-only";

import { cache } from "react";
import type { Hex } from "viem";
import { fetchMorphoRestResource, restSelector } from "@/common/utils/fetchMorphoRest";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { type RestVaultV1Allocation, withdrawQueueAllocations } from "./adapters";

// The markets the app can show are whatever the configured vaults allocate to. For a vault V2 that
// means its MarketV1 caps plus whatever its adapters hold: a vault V1 through a vault V1 adapter, or
// another vault V2 through a vault V2 adapter. The traversal lives here, in the vault module,
// because it is entirely a walk of vault config and vault allocation structure; the market module
// consumes the plain result (see `getSupportedMarketIds`).
//
// Core REST serves a vault's whole allocation set in one unpaged response, so no read here can stop
// short of the full set. An adapter's target is on the vault's own chain.
//
// REST also serves markets tied to a vault only by a pending, not yet accepted, change: a vault V1
// market outside the withdraw queue, or a vault V2 cap whose increase is still timelocked. A curator
// can submit those on their own, so they must not widen the whitelist. GraphQL never listed them.

interface RestVaultV1Allocations {
  data: { allocations: RestVaultV1Allocation[] };
}

type RestVaultV2Target =
  | { type: "blue_market" }
  | { type: "vault_v1"; vault_address: string }
  | { type: "vault_v2"; vault_address: string }
  | { type: "unknown"; target_address: string };

interface RestVaultV2Allocations {
  data: {
    allocations: {
      caps: (
        | { cap_type: "market_v1"; market_id: Hex; absolute_cap: string; allocated_assets: string }
        | {
            cap_type: "adapter";
          }
      )[];
      target: RestVaultV2Target;
    }[];
  };
}

// A vault V2 adapter can wrap another vault V2, which can wrap another. Each level costs a round
// trip, so the walk is bounded; nothing in production nests at all today.
const MAX_ADAPTER_DEPTH = 3;

interface VaultRef {
  chainId: SupportedChainId;
  address: string;
}

type AddMarket = (chainId: SupportedChainId, marketId: Hex) => void;

const refKey = (ref: VaultRef) => `${ref.chainId}:${ref.address.toLowerCase()}`;

async function collectVaultV1Markets(refs: VaultRef[], add: AddMarket): Promise<void> {
  await Promise.all(
    refs.map(async (ref) => {
      const response = await fetchMorphoRestResource<RestVaultV1Allocations>(
        `/v0/vaults-v1/${restSelector(ref.chainId, ref.address)}/allocations`,
      );
      if (!response) {
        console.warn(`Vault V1 not returned by the API, skipping its markets: ${refKey(ref)}`);
        return;
      }
      // Only markets in the withdraw queue: the vault can hold them now.
      for (const allocation of withdrawQueueAllocations(response.data.allocations)) {
        add(ref.chainId, allocation.market_id);
      }
    }),
  );
}

async function collectVaultV2Markets(refs: VaultRef[], add: AddMarket, visited: Set<string>, depth = 0): Promise<void> {
  // A vault reached twice (a diamond, or a cycle through adapters) contributes nothing new.
  const pending = refs.filter((ref) => !visited.has(refKey(ref)));
  if (pending.length === 0) return;
  for (const ref of pending) visited.add(refKey(ref));

  const innerV1Vaults: VaultRef[] = [];
  const innerV2Vaults: VaultRef[] = [];

  await Promise.all(
    pending.map(async (ref) => {
      const response = await fetchMorphoRestResource<RestVaultV2Allocations>(
        `/v0/vaults-v2/${restSelector(ref.chainId, ref.address)}/allocations`,
      );
      if (!response) {
        console.warn(`Vault V2 not returned by the API, skipping its markets: ${refKey(ref)}`);
        return;
      }

      for (const allocation of response.data.allocations) {
        for (const cap of allocation.caps) {
          // REST also lists a cap the curator has zeroed, and a cap whose first increase is still
          // pending (served as 0 until it executes); with nothing allocated, the vault cannot reach
          // that market. GraphQL omitted both.
          if (
            cap.cap_type !== "market_v1" ||
            (BigInt(cap.absolute_cap) === 0n && BigInt(cap.allocated_assets) === 0n)
          ) {
            continue;
          }
          add(ref.chainId, cap.market_id);
        }

        const { target } = allocation;
        switch (target.type) {
          case "vault_v1":
            innerV1Vaults.push({ chainId: ref.chainId, address: target.vault_address });
            break;
          case "vault_v2":
            innerV2Vaults.push({ chainId: ref.chainId, address: target.vault_address });
            break;
          // A market adapter's markets are its MarketV1 caps, already added above. An unknown
          // adapter is skipped: its markets are missing from the whitelist until the app learns it,
          // which narrows the borrow table — the alternative, throwing, would take down every page.
          default:
            break;
        }
      }
    }),
  );

  const inner: Promise<void>[] = [];
  if (innerV1Vaults.length > 0) inner.push(collectVaultV1Markets(innerV1Vaults, add));
  if (innerV2Vaults.length > 0) {
    if (depth + 1 >= MAX_ADAPTER_DEPTH) {
      console.warn(
        `Vault V2 adapters nest deeper than ${MAX_ADAPTER_DEPTH} levels; the innermost markets are dropped.`,
      );
    } else {
      inner.push(collectVaultV2Markets(innerV2Vaults, add, visited, depth + 1));
    }
  }
  await Promise.all(inner);
}

/** Every market the configured vaults allocate to, keyed by chain. Uncached; see callers. */
export const getVaultMarketIds = cache(async (): Promise<Record<SupportedChainId, Hex[]>> => {
  const configuredVaults = Object.entries(APP_CONFIG.supportedVaults).flatMap(([chainId, vaults]) =>
    vaults.map((vault) => ({ chainId: Number.parseInt(chainId) as SupportedChainId, ...vault })),
  );

  const v2Refs = configuredVaults.filter((vault) => vault.protocol === Erc4626VaultProtocol.MorphoV2);
  const v1Refs = configuredVaults.filter((vault) => vault.protocol === Erc4626VaultProtocol.MorphoV1);

  const marketWhitelist = {} as Record<SupportedChainId, Set<Hex>>;
  const add: AddMarket = (chainId, marketId) => {
    (marketWhitelist[chainId] ??= new Set()).add(marketId);
  };

  await Promise.all([
    v2Refs.length > 0 ? collectVaultV2Markets(v2Refs, add, new Set()) : undefined,
    v1Refs.length > 0 ? collectVaultV1Markets(v1Refs, add) : undefined,
  ]);

  const result = {} as Record<SupportedChainId, Hex[]>;
  for (const [chainId, marketIds] of Object.entries(marketWhitelist)) {
    result[Number(chainId) as SupportedChainId] = Array.from(marketIds);
  }

  return result;
});
