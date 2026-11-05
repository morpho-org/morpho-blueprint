import { MathLib } from "@morpho-org/blue-sdk";
import { morphoViemExtension } from "@morpho-org/morpho-sdk";
import { encodeFunctionData, isAddressEqual, maxUint256 } from "viem";
import { wrappedNativeAssetAbi } from "@/actions/abis/wrappedNativeAssetAbi";
import { getChainAddressesRequired } from "@/actions/utils/getChainAddressesRequired";
import { transactionRequestsFromMorphoAction } from "@/actions/utils/morphoAction";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { type Erc4626WithdrawActionParameters, UserFacingError, type VaultAction } from "../../types";
import { fetchErc4626WithdrawData, validateErc4626WithdrawParameters } from "./helpers";

export async function erc4626WithdrawViaMorphoSdkAction({
  client,
  vaultAddress,
  accountAddress,
  withdrawAmount,
  unwrapNativeAssets,
}: Erc4626WithdrawActionParameters): Promise<VaultAction> {
  validateErc4626WithdrawParameters({ vaultAddress, accountAddress, withdrawAmount });
  const isFullWithdraw = withdrawAmount === maxUint256;
  const vaultConfig = APP_CONFIG.supportedVaults[client.chain.id as SupportedChainId]?.find((vault) =>
    isAddressEqual(vault.address, vaultAddress),
  );
  if (!vaultConfig) throw new UserFacingError("Vault is not configured.");
  const { data, error } = await tryCatch(
    fetchErc4626WithdrawData({ client, vaultAddress, accountAddress, withdrawAmount }),
  );
  if (error) throw new UserFacingError("Unable to load vault data.", { cause: error });
  if (!isFullWithdraw && data.initialPosition.assets < withdrawAmount) {
    throw new UserFacingError("Withdraw amount exceeds account balance.");
  }
  if (data.quotedSharesRedeemed === 0n) {
    throw new UserFacingError("Vault quoted 0 shares redeemed. Try to increase the withdraw amount.");
  }
  if (data.initialPosition.shares === 0n) throw new UserFacingError("Account has no shares to withdraw.");

  const morpho = client.extend(morphoViemExtension({ supportSignature: false })).morpho;
  const slippageTolerance = APP_CONFIG.actionParameters.bundler3Config.slippageToleranceWad;
  const params = { amount: withdrawAmount, userAddress: accountAddress, slippageTolerance };
  const output = await (async () => {
    if (vaultConfig.protocol === Erc4626VaultProtocol.MorphoV1) {
      const vault = morpho.vaultV1(vaultAddress, client.chain.id);
      return isFullWithdraw
        ? vault.redeem({ shares: data.initialPosition.shares, userAddress: accountAddress })
        : vault.withdraw({ ...params, vaultData: await vault.getData() });
    }
    if (vaultConfig.protocol === Erc4626VaultProtocol.MorphoV2) {
      const vault = morpho.vaultV2(vaultAddress, client.chain.id);
      return isFullWithdraw
        ? vault.redeem({ shares: data.initialPosition.shares, userAddress: accountAddress })
        : vault.withdraw({ ...params, vaultData: await vault.getData() });
    }
    throw new UserFacingError("Vault protocol is not supported.");
  })();
  const transactionRequests = await transactionRequestsFromMorphoAction(output, "Withdraw from vault");
  const { wrappedNativeAssetAddress } = getChainAddressesRequired(client.chain.id);
  if (isAddressEqual(data.underlyingAssetAddress, wrappedNativeAssetAddress) && unwrapNativeAssets) {
    // Full redeems may accrue slightly before execution, leaving the difference as WETH dust.
    const unwrapAmount = isFullWithdraw
      ? MathLib.wMulDown(data.initialPosition.assets, MathLib.WAD - slippageTolerance)
      : withdrawAmount;
    transactionRequests.push({
      name: "Unwrap native asset",
      tx: () => ({
        to: wrappedNativeAssetAddress,
        data: encodeFunctionData({ abi: wrappedNativeAssetAbi, functionName: "withdraw", args: [unwrapAmount] }),
      }),
    });
  }
  return {
    chainId: client.chain.id,
    signatureRequests: [],
    transactionRequests,
    positionChange: {
      balance: {
        before: data.initialPosition.assets,
        after: isFullWithdraw ? 0n : data.initialPosition.assets - withdrawAmount,
      },
    },
  };
}
