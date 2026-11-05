import { type Market, MathLib } from "@morpho-org/blue-sdk";
import type { BlueActions } from "@morpho-org/morpho-sdk";
import type { Address } from "viem";
import { getBlock } from "viem/actions";
import { APP_CONFIG } from "@/config";
import type { ClientWithChain } from "../types";

export async function getMarketBorrowReallocations({
  publicClient,
  market,
  marketData,
  allocatingVaultAddresses,
  borrowAmount,
}: {
  publicClient: ClientWithChain;
  market: Pick<BlueActions, "getVaultV2BlueReallocationData" | "getVaultV2BlueReallocations">;
  marketData: Pick<Market, "totalSupplyAssets" | "totalBorrowAssets">;
  allocatingVaultAddresses: Address[];
  borrowAmount: bigint;
}) {
  const utilization =
    marketData.totalSupplyAssets > 0n
      ? MathLib.wDivDown(marketData.totalBorrowAssets + borrowAmount, marketData.totalSupplyAssets)
      : 0n;
  if (
    borrowAmount === 0n ||
    allocatingVaultAddresses.length === 0 ||
    utilization <= APP_CONFIG.actionParameters.publicAllocatorSupplyTargetUtilizationWad
  ) {
    return undefined;
  }
  return market.getVaultV2BlueReallocations({
    reallocationData: await market.getVaultV2BlueReallocationData({
      vaultAddresses: allocatingVaultAddresses,
      block: await getBlock(publicClient),
    }),
    options: { operation: { type: "borrow", amount: borrowAmount } },
  }).reallocations;
}
