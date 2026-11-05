import { MathLib } from "@morpho-org/blue-sdk";
import { morphoViemExtension } from "@morpho-org/morpho-sdk";
import { encodeFunctionData, isAddressEqual } from "viem";
import { wrappedNativeAssetAbi } from "@/actions/abis/wrappedNativeAssetAbi";
import { getChainAddressesRequired } from "@/actions/utils/getChainAddressesRequired";
import { transactionRequestsFromMorphoAction } from "@/actions/utils/morphoAction";
import { tryCatch } from "@/common/utils/tryCatch";
import { APP_CONFIG } from "@/config";
import type { SupportedChainId } from "@/config/types";
import { Erc4626VaultProtocol } from "@/config/vault-protocol";
import { type Erc4626SupplyActionParameters, UserFacingError, type VaultAction } from "../../types";
import { fetchErc4626SupplyData, validateErc4626SupplyParameters } from "./helpers";

export async function erc4626SupplyViaMorphoSdkAction({
  client,
  vaultAddress,
  accountAddress,
  supplyAmount,
  allowNativeAssetWrapping,
}: Erc4626SupplyActionParameters): Promise<VaultAction> {
  validateErc4626SupplyParameters({ vaultAddress, accountAddress, supplyAmount });
  const vaultConfig = APP_CONFIG.supportedVaults[client.chain.id as SupportedChainId]?.find((vault) =>
    isAddressEqual(vault.address, vaultAddress),
  );
  if (!vaultConfig) throw new UserFacingError("Vault is not configured.");

  const { wrappedNativeAssetAddress } = getChainAddressesRequired(client.chain.id);
  const { data, error } = await tryCatch(
    fetchErc4626SupplyData({ client, vaultAddress, accountAddress, supplyAmount, spender: vaultAddress }),
  );
  if (error) throw new UserFacingError("Unable to load vault data.", { cause: error });

  const shortfall = MathLib.zeroFloorSub(supplyAmount, data.accountUnderlyingAssetBalance);
  const canWrap = isAddressEqual(data.underlyingAssetAddress, wrappedNativeAssetAddress) && allowNativeAssetWrapping;
  const wrapAmount = canWrap ? MathLib.min(shortfall, data.accountNativeAssetBalance) : 0n;
  if (data.accountUnderlyingAssetBalance + wrapAmount < supplyAmount) {
    throw new UserFacingError("Supply amount exceeds the account balance.");
  }
  if (data.quotedShares === 0n) {
    throw new UserFacingError("Vault quoted 0 shares. Try to increase the supply amount.");
  }

  const morpho = client.extend(morphoViemExtension({ supportSignature: false })).morpho;
  const params = {
    amount: supplyAmount,
    userAddress: accountAddress,
    slippageTolerance: APP_CONFIG.actionParameters.bundler3Config.slippageToleranceWad,
  };
  const output = await (async () => {
    if (vaultConfig.protocol === Erc4626VaultProtocol.MorphoV1) {
      const vault = morpho.vaultV1(vaultAddress, client.chain.id);
      return vault.deposit({ ...params, vaultData: await vault.getData() });
    }
    if (vaultConfig.protocol === Erc4626VaultProtocol.MorphoV2) {
      const vault = morpho.vaultV2(vaultAddress, client.chain.id);
      return vault.deposit({ ...params, vaultData: await vault.getData() });
    }
    throw new UserFacingError("Vault protocol is not supported.");
  })();
  const transactionRequests = await transactionRequestsFromMorphoAction(output, "Supply to vault");
  if (wrapAmount > 0n) {
    transactionRequests.unshift({
      name: "Wrap native assets",
      tx: () => ({
        to: wrappedNativeAssetAddress,
        data: encodeFunctionData({ abi: wrappedNativeAssetAbi, functionName: "deposit" }),
        value: wrapAmount,
      }),
    });
  }
  return {
    chainId: client.chain.id,
    signatureRequests: [],
    transactionRequests,
    positionChange: {
      balance: { before: data.initialPosition.assets, after: data.initialPosition.assets + supplyAmount },
    },
  };
}
