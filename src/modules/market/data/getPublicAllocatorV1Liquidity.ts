import "server-only";
// Registers the public allocator on chains the SDK does not ship addresses for.
import "@/actions/morphoSdkPatch";

import type { MarketId } from "@morpho-org/blue-sdk";
import { type Address, createPublicClient, fallback, http, zeroAddress } from "viem";
import { getSimulationState } from "@/actions/data/rpc/getSimulationState";
import { redactError } from "@/common/utils/redactError";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { computePublicAllocatorV1Liquidity } from "@/modules/market/utils/computePublicAllocatorV1Liquidity";

/**
 * What the borrow can pull into the market through the Public Allocator V1 from `vaultAddresses`
 * (the configured V1 vaults that supply it, the same candidates the borrow action passes). No Morpho
 * API serves Public Allocator V1 state, so this reads the chain with the action's own simulation
 * state. Talks to the configured RPC URLs directly: the `/api/rpc` proxy rejects server calls.
 *
 * Any failure degrades to 0: "Available to Borrow" then shows the market's own liquidity, which
 * the borrow can always reach.
 */
export async function getPublicAllocatorV1Liquidity(
  chainId: SupportedChainId,
  marketId: MarketId,
  vaultAddresses: readonly Address[],
): Promise<bigint> {
  if (vaultAddresses.length === 0) return 0n;

  const chainConfig = APP_CONFIG.chainConfig[chainId];
  if (!chainConfig) return 0n;

  const publicClient = createPublicClient({
    chain: chainConfig.chain,
    transport: fallback(chainConfig.rpcUrls.map((url) => http(url))),
    batch: { multicall: true },
  });

  const { data, error } = await tryCatch(
    getSimulationState({
      publicClient,
      // No account takes part: the reallocation only reads the market and the vaults.
      accountAddress: zeroAddress,
      actionType: "market",
      marketId,
      requiresPublicReallocation: true,
      allocatingVaultAddresses: [...vaultAddresses],
    }).then((state) => computePublicAllocatorV1Liquidity(state, marketId)),
  );
  if (error) {
    console.warn(`Public Allocator V1 liquidity read failed for ${chainId}:${marketId}: ${redactError(error)}`);
    return 0n;
  }
  return data;
}
