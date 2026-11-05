import type { MarketId } from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import { morphoViemExtension } from "@morpho-org/morpho-sdk";
import { type Address, erc20Abi, maxUint256 } from "viem";
import { readContract } from "viem/actions";
import { type ClientWithChain, type MarketAction, UserFacingError } from "../types";
import { getMarketBorrowReallocations } from "../utils/getMarketBorrowReallocations";
import { transactionRequestsFromMorphoAction } from "../utils/morphoAction";
import { computeMarketPositionChange } from "../utils/positionChange";

interface MarketSupplyCollateralAndBorrowActionParameters {
  publicClient: ClientWithChain;
  marketId: MarketId;
  allocatingVaultAddresses: Address[];
  accountAddress: Address;
  collateralAmount: bigint;
  borrowAmount: bigint;
}

export async function marketSupplyCollateralAndBorrowAction({
  publicClient,
  marketId,
  allocatingVaultAddresses,
  accountAddress,
  collateralAmount,
  borrowAmount,
}: MarketSupplyCollateralAndBorrowActionParameters): Promise<MarketAction> {
  if (collateralAmount < 0n || borrowAmount < 0n) {
    throw new UserFacingError("Collateral and borrow amounts cannot be negative.");
  }
  if (collateralAmount === 0n && borrowAmount === 0n) {
    throw new UserFacingError("Collateral and borrow amounts cannot both be 0.");
  }
  const marketData = await fetchMarket(marketId, publicClient);
  const market = publicClient
    .extend(morphoViemExtension({ supportSignature: false }))
    .morpho.blue(marketData.params, publicClient.chain.id);
  const positionData = await market.getPositionData(accountAddress);
  const collateralBalance = await readContract(publicClient, {
    address: marketData.params.collateralToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accountAddress],
  });
  const collateralAssets = collateralAmount === maxUint256 ? collateralBalance : collateralAmount;
  if (collateralAssets > collateralBalance) {
    throw new UserFacingError("Collateral amount exceeds the account balance.");
  }
  const reallocations = await getMarketBorrowReallocations({
    publicClient,
    market,
    marketData,
    allocatingVaultAddresses,
    borrowAmount,
  });
  const output = market.supplyCollateralBorrow({
    userAddress: accountAddress,
    positionData,
    collateralAssets,
    borrowAssets: borrowAmount,
    reallocations,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 30 * 60),
  });
  return {
    chainId: publicClient.chain.id,
    signatureRequests: [],
    transactionRequests: await transactionRequestsFromMorphoAction(
      output,
      `Confirm ${collateralAssets > 0n ? "Supply" : ""}${collateralAssets > 0n && borrowAmount > 0n ? " & " : ""}${borrowAmount > 0n ? "Borrow" : ""}`,
    ),
    positionChange: computeMarketPositionChange(marketData, positionData, collateralAssets, borrowAmount),
  };
}
