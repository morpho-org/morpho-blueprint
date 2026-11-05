import type { MarketId } from "@morpho-org/blue-sdk";
import { fetchMarket } from "@morpho-org/blue-sdk-viem";
import { morphoViemExtension } from "@morpho-org/morpho-sdk";
import { type Address, erc20Abi, maxUint256 } from "viem";
import { readContract } from "viem/actions";
import { type ClientWithChain, type MarketAction, UserFacingError } from "../types";
import { transactionRequestsFromMorphoAction } from "../utils/morphoAction";
import { computeMarketPositionChange } from "../utils/positionChange";

interface MarketRepayAndWithdrawCollateralActionParameters {
  publicClient: ClientWithChain;
  marketId: MarketId;
  accountAddress: Address;
  repayAmount: bigint;
  withdrawCollateralAmount: bigint;
}

export async function marketRepayAndWithdrawCollateralAction({
  publicClient,
  marketId,
  accountAddress,
  repayAmount,
  withdrawCollateralAmount,
}: MarketRepayAndWithdrawCollateralActionParameters): Promise<MarketAction> {
  if (repayAmount < 0n || withdrawCollateralAmount < 0n) {
    throw new UserFacingError("Repay and withdraw collateral amounts cannot be negative.");
  }
  if (repayAmount === 0n && withdrawCollateralAmount === 0n) {
    throw new UserFacingError("Repay and withdraw collateral amounts cannot both be 0.");
  }
  const marketData = await fetchMarket(marketId, publicClient);
  const market = publicClient
    .extend(morphoViemExtension({ supportSignature: false }))
    .morpho.blue(marketData.params, publicClient.chain.id);
  const positionData = await market.getPositionData(accountAddress);
  const isMaxRepay = repayAmount === maxUint256;
  const collateralAssets = withdrawCollateralAmount === maxUint256 ? positionData.collateral : withdrawCollateralAmount;
  const output = market.repayWithdrawCollateral({
    userAddress: accountAddress,
    positionData,
    collateralAssets,
    ...(isMaxRepay ? { repayShares: maxUint256 } : { repayAssets: repayAmount }),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 30 * 60),
  });
  const loanBalance = await readContract(publicClient, {
    address: marketData.params.loanToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accountAddress],
  });
  const repayAssets = isMaxRepay ? marketData.toBorrowAssets(positionData.borrowShares) : repayAmount;
  if (repayAssets > loanBalance) {
    throw new UserFacingError("Repay amount exceeds the account balance.");
  }
  return {
    chainId: publicClient.chain.id,
    signatureRequests: [],
    transactionRequests: await transactionRequestsFromMorphoAction(
      output,
      `Confirm ${repayAmount > 0n ? "Repay" : ""}${repayAmount > 0n && collateralAssets > 0n ? " & " : ""}${collateralAssets > 0n ? "Withdraw" : ""}`,
    ),
    positionChange: computeMarketPositionChange(
      marketData,
      positionData,
      -collateralAssets,
      -(isMaxRepay ? marketData.toBorrowAssets(positionData.borrowShares) : repayAmount),
    ),
  };
}
